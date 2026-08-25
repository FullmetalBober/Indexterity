import { Injectable, Logger } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import type { Cluster } from "@repo/contracts";
import type { RequestActor } from "../audit/http-actor";
import { recordSecurityEvent } from "../audit/security-events";
import { currentKeyVersion, masterKeyBytesFor } from "../config/env";
import { clusters, envKeyProvider, eq, seal, sql } from "../db";
import { DatabaseService } from "../db/database.service";
import { allowPrivateTargets, assertTargetsAllowed, BlockedTargetError } from "../engine/net-guard";
import { DatabaseInaccessibleError, NO_TLS_OVERRIDES, type TlsOverrides } from "../engine/ports";
import { revokeCommandFor } from "../engine/provision";
import { adapterFor, engineSupported, supportedEngines } from "../engine/registry";
import { InsecureConnectionError } from "../engine/tls";
import { consumeDialBudget } from "../errors/dial-budget";
import { mapClusterError, toCluster } from "../http/mappers";
import { ClusterGoneError, openClusterSession } from "../jobs/cluster-connection";
import { type ClusterRow, ClustersRepository } from "./clusters.repository";
import { restoreHiddenIndexes } from "./offboard";

// Contract error shapes travel down rather than being rewritten (#333). The
// dashboard branches on the code, so a service that refuses takes the handler's
// own `errors` map instead of throwing a bare ORPCError that would work on the
// wire and lose the reason.
interface NotFound {
  NOT_FOUND: (options: { message: string }) => Error;
}
interface BadRequest {
  BAD_REQUEST: (options: { message: string }) => Error;
}

export function duplicateNameMessage(name: string): string {
  return `this organization already has a cluster called "${name}" — pick another name`;
}

const CLUSTER_NAME_CONSTRAINT = "clusters_org_name";

// `clusters_org_name` refused the write: this org already has a cluster by that
// name (db/schema.ts). Postgres reports it on the driver's error rather than
// through anything drizzle models, and the constraint is named in the schema
// precisely so this check can be about that one rule instead of "some unique
// index somewhere on clusters".
//
// Caught as well as pre-checked, because two writers racing on the same name
// would both find nothing and both go ahead, and the constraint is the only
// answer that cannot lose that race.
//
// Walks the cause chain, because drizzle wraps what the driver threw — the pg
// error with `code`/`constraint` on it is the cause of a DrizzleQueryError, not
// the error itself. Reading the top-level object only was a 500 for a duplicate
// name, which is the failure this function exists to prevent.
export function isDuplicateClusterName(error: unknown): boolean {
  let current: unknown = error;
  // Bounded: a cause chain that points back at itself must not spin here.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (
      Reflect.get(current, "code") === "23505" &&
      Reflect.get(current, "constraint") === CLUSTER_NAME_CONSTRAINT
    ) {
      return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

// The cluster use cases that do not carry credentials.
//
// Connect, provision and rotate stay in the controller for now and move next
// (#333 orders clusters last and splits it further): they share the sealing,
// diagnosis and posture logic, and moving them in the same change as these would
// make the one PR that touches stored credentials also the largest.
@Injectable()
export class ClustersService {
  private readonly log = new Logger(ClustersService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ClustersRepository,
  ) {}

  // The actor arrives as a THUNK. Who is asking is a fact about the REQUEST, so
  // it is read in the controller — and it is only paid for when something
  // actually happened, which is why it is not resolved eagerly.
  private async record(
    actor: () => Promise<RequestActor>,
    entry: Parameters<typeof recordSecurityEvent>[1],
    warn: (message: string) => void,
  ): Promise<void> {
    await recordSecurityEvent(this.database.db, { ...entry, ...(await actor()) }, warn);
  }

  // The row, or the refusal. Every handler that needs the cluster before acting
  // on it asks this rather than re-spelling the ownership predicate and the
  // not-found message.
  async ownedById(clusterId: string, orgId: string, errors: NotFound): Promise<ClusterRow> {
    const row = await this.repository.ownedById(clusterId, orgId);
    if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
    return row;
  }

  // Re-seal a cluster's connection string under the current key, with whatever
  // the caller decided about the scoped-user marker beside it.
  //
  // The sealing lives here rather than in the handler for the same reason
  // storeCluster's does: it is the one place a customer credential is turned
  // into bytes at rest, and a second copy of that code is how the two drift.
  async reseal(
    clusterId: string,
    connectionString: string,
    fields: {
      provisionedUsername: string | null;
      provisionedDatabases: string[] | null;
      credentialPosture: typeof clusters.$inferSelect.credentialPosture;
    },
    errors: NotFound,
  ): Promise<ClusterRow> {
    const keyVersion = currentKeyVersion();
    const sealed = await seal(
      new TextEncoder().encode(connectionString),
      envKeyProvider(masterKeyBytesFor(keyVersion)),
    );
    const [updated] = await this.database.db
      .update(clusters)
      .set({
        sealedDek: Buffer.from(sealed.dek),
        sealedData: Buffer.from(sealed.data),
        keyVersion,
        ...fields,
      })
      .where(eq(clusters.id, clusterId))
      .returning();
    if (updated === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
    return updated;
  }

  async storeCluster(
    orgId: string,
    name: string,
    engine: typeof clusters.$inferSelect.engine,
    connectionString: string,
    // Username and databases together, because neither is meaningful alone: the
    // databases say where THIS user was created, and a row with no provisioned
    // user has nothing to say about databases at all (#338).
    provisioned: { username: string; databases: readonly string[] } | null,
    // What these credentials COULD do, as opposed to what `readOnly` allows.
    // Recorded at the moment they are stored, because that is the only time we
    // have a diagnosis in hand — asking again later would mean dialling.
    credentialPosture: typeof clusters.$inferSelect.credentialPosture,
    tlsOverrides: TlsOverrides = NO_TLS_OVERRIDES,
    // Which databases to observe, or null for every one the cluster has (#244).
    // Undefined from a caller that has no opinion is stored as null, which is the
    // same behaviour every cluster had before the column existed.
    observedDatabases: string[] | null = null,
  ): Promise<typeof clusters.$inferSelect> {
    const keyVersion = currentKeyVersion();
    const sealed = await seal(
      new TextEncoder().encode(connectionString),
      envKeyProvider(masterKeyBytesFor(keyVersion)),
    );
    // The name was checked before the dial (assertNameFree); this is the same
    // refusal for the case that check cannot see, which is another connect
    // committing the same name in between.
    let row: typeof clusters.$inferSelect | undefined;
    try {
      [row] = await this.database.db
        .insert(clusters)
        .values({
          orgId,
          name,
          connectionMode: "HOSTED_DIRECT",
          engine,
          readOnly: true,
          sealedDek: Buffer.from(sealed.dek),
          sealedData: Buffer.from(sealed.data),
          keyVersion,
          provisionedUsername: provisioned?.username ?? null,
          provisionedDatabases: provisioned === null ? null : [...provisioned.databases],
          credentialPosture,
          tlsOverrides,
          observedDatabases,
        })
        .returning();
    } catch (error) {
      if (isDuplicateClusterName(error)) {
        throw new ORPCError("BAD_REQUEST", { message: duplicateNameMessage(name) });
      }
      throw error;
    }
    if (row === undefined) throw new Error("failed to create cluster");
    // Collect once, now, rather than at the next scheduled pass. Connecting a
    // cluster and then waiting up to six hours for the dashboard to say anything
    // is the complaint that reads as "the cadence is too long" — and it is a
    // different problem with a different fix. Shortening the cadence for everyone
    // would buy this one moment at the cost of every hour afterwards; one job on
    // connect buys it outright and changes the steady-state load by nothing.
    //
    // Queued rather than awaited: a collect walks every collection and can take
    // minutes on a large cluster, and the caller is waiting on a POST.
    //
    // Best-effort on purpose. The insert above has already committed, so a failed
    // enqueue must not turn a connect that worked into an error the reader cannot
    // act on — they would see "failed to connect" next to a cluster that is
    // there. Losing it costs the first collect its head start and nothing else:
    // the scheduled pass is still behind it, which is exactly where this used to
    // happen. Logged rather than swallowed, because a queue that cannot be
    // written to is worth knowing about (§16).
    try {
      await this.database.db.execute(
        sql`select graphile_worker.add_job('collect', json_build_object('clusterId', ${row.id}::text), max_attempts => 3)`,
      );
    } catch (error) {
      this.log.warn(
        `could not queue the first collect for cluster ${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return row;
  }

  // Everything that must be true before the control plane dials a customer
  // host: a supported engine, a mongodb scheme, a per-user budget, and a
  // target that is not somewhere on our own network (the wiki's Architecture
  // page, Security). Every endpoint that opens a connection goes through here.
  async guardDial(
    userId: string,
    engine: typeof clusters.$inferSelect.engine,
    value: string,
    errors: { BAD_REQUEST: (options: { message: string }) => Error },
    overrides: TlsOverrides = NO_TLS_OVERRIDES,
  ): Promise<void> {
    if (!engineSupported(engine)) {
      throw errors.BAD_REQUEST({
        message:
          `${engine} support is planned — ` +
          `${supportedEngines().join(" and ")} clusters can connect today`,
      });
    }
    const adapter = adapterFor(engine);
    if (!adapter.isConnString(value)) {
      throw errors.BAD_REQUEST({
        message: `connection string must be ${adapter.connStringHint}`,
      });
    }
    await consumeDialBudget(this.database.db, userId);
    const { hosts, isSrv } = adapter.hostsOf(value);
    try {
      await assertTargetsAllowed(hosts, isSrv, { allowPrivate: allowPrivateTargets() });
    } catch (error) {
      if (error instanceof BlockedTargetError) {
        throw errors.BAD_REQUEST({ message: error.message });
      }
      throw error;
    }
    // AFTER the address guard, deliberately. A private or loopback target is
    // refused whatever its transport, and answering "you need TLS" to someone
    // pointing at 10.0.0.5 would name the wrong problem — and quietly weaken the
    // SSRF message that is the more severe of the two.
    //
    // The enforcement itself lives in each adapter's client module, because the
    // worker never comes through here: jobs/connection-pool.ts opens the STORED
    // string. This
    // is only so onboarding refuses with the reason instead of surfacing the same
    // refusal as a 502 out of diagnose.
    try {
      adapter.assertSecureTransport(value, overrides);
    } catch (error) {
      if (error instanceof InsecureConnectionError) {
        throw errors.BAD_REQUEST({ message: error.message });
      }
      throw error;
    }
  }

  async list(orgId: string): Promise<Cluster[]> {
    const rows = await this.repository.listForOrg(orgId);
    const lastByCluster = await this.repository.lastCollectedByCluster(rows.map((row) => row.id));
    return rows.map((row) => toCluster(row, lastByCluster.get(row.id) ?? null));
  }

  // Everything collected is deleted and cannot be re-collected as it was, which
  // is why the route above this is `freshOwner` rather than `owner` (#52).
  async disconnect(
    orgId: string,
    clusterId: string,
    errors: NotFound,
    actor: () => Promise<RequestActor>,
    warn: (message: string) => void,
  ): Promise<{ unhidden: number; revokeCommand: string | null }> {
    const row = await this.ownedById(clusterId, orgId, errors);
    const unhidden = await restoreHiddenIndexes(this.database.db, clusterId);
    await this.repository.deleteById(clusterId);
    // `clusterId` stays null here and the id goes in the metadata: the row it
    // would point at has just been deleted, and this event is the one that has to
    // outlive it — everything else about that cluster is gone.
    await this.record(
      actor,
      {
        event: "CLUSTER_DISCONNECTED",
        orgId,
        target: row.name,
        metadata: {
          clusterId: row.id,
          unhidden,
          provisionedUsername: row.provisionedUsername,
        },
      },
      warn,
    );
    return {
      unhidden,
      revokeCommand: revokeCommandFor(
        row.engine,
        row.provisionedUsername,
        row.provisionedDatabases,
      ),
    };
  }

  // Nothing on the customer's cluster is affected — the provisioned user is
  // derived from the admin connection string, never from this name (#96).
  async rename(
    orgId: string,
    clusterId: string,
    name: string,
    errors: NotFound & BadRequest,
  ): Promise<Cluster> {
    if (await this.repository.nameTaken(orgId, name, clusterId)) {
      throw errors.BAD_REQUEST({ message: duplicateNameMessage(name) });
    }
    let row: ClusterRow | undefined;
    try {
      row = await this.repository.rename(clusterId, orgId, name);
    } catch (error) {
      if (isDuplicateClusterName(error)) {
        throw errors.BAD_REQUEST({ message: duplicateNameMessage(name) });
      }
      throw error;
    }
    if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
    return toCluster(row);
  }

  async setMode(
    orgId: string,
    clusterId: string,
    readOnly: boolean,
    errors: NotFound,
    actor: () => Promise<RequestActor>,
    warn: (message: string) => void,
  ): Promise<Cluster> {
    const row = await this.repository.setMode(clusterId, orgId, readOnly);
    if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
    await this.record(
      actor,
      {
        event: "CLUSTER_MODE_CHANGED",
        orgId,
        clusterId: row.id,
        target: row.name,
        metadata: { readOnly },
      },
      warn,
    );
    return toCluster(row);
  }

  // The lease is `allDatabases`, so the answer is what the cluster HAS rather
  // than what we are already watching — the whole reason this route exists is to
  // offer a database that appeared after onboarding (#244).
  async listDatabases(
    clusterId: string,
    errors: NotFound,
  ): Promise<{ available: string[]; observed: string[] | null }> {
    const lease = await this.openAllDatabases(clusterId, errors);
    try {
      return {
        available: await lease.session.listDatabaseNames(),
        observed: lease.observedDatabases === null ? null : [...lease.observedDatabases],
      };
    } catch (error) {
      mapClusterError(error);
    } finally {
      lease.release();
    }
  }

  async queueCollect(clusterId: string): Promise<{ queued: true }> {
    await this.repository.queueCollect(clusterId);
    return { queued: true };
  }

  private async openAllDatabases(
    clusterId: string,
    errors: NotFound,
  ): Promise<Awaited<ReturnType<typeof openClusterSession>>> {
    try {
      return await openClusterSession(this.database.db, clusterId, { allDatabases: true });
    } catch (error) {
      if (error instanceof ClusterGoneError) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      mapClusterError(error);
    }
  }

  // Which of the wanted databases this cluster does not have, and which of the
  // newly added ones the stored credentials cannot read.
  async unusableDatabases(
    clusterId: string,
    wanted: readonly string[],
    added: readonly string[],
    errors: NotFound,
  ): Promise<{ absent: string[]; unreadable: string[] }> {
    const none = { absent: [], unreadable: [] };
    let lease: Awaited<ReturnType<typeof openClusterSession>>;
    try {
      lease = await openClusterSession(this.database.db, clusterId, { allDatabases: true });
    } catch (error) {
      if (error instanceof ClusterGoneError) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      return none;
    }
    try {
      const available = await lease.session.listDatabaseNames();
      const absent = wanted.filter((name) => !available.includes(name));
      // Existence is not access, and on SQL Server the two come apart in exactly
      // the way that matters here: `sys.databases` lists every database to every
      // login (VIEW ANY DATABASE is granted to public — verified on 2022), while a
      // scoped login provisioned for two databases of twelve has no user in the
      // other ten and gets Msg 916 on every read. So a database that passes the
      // check above can still be one we will never see a table in.
      //
      // Probed only for the databases being ADDED. The ones already selected are
      // either working or already visible as a gap on the dashboard, and probing
      // them would make every save cost a round trip per database for an answer
      // nobody asked for.
      const unreadable: string[] = [];
      for (const database of added) {
        if (absent.includes(database)) continue;
        try {
          await lease.session.collector.listCollectionNames(database);
        } catch (error) {
          if (!(error instanceof DatabaseInaccessibleError)) throw error;
          unreadable.push(database);
        }
      }
      return { absent, unreadable };
    } catch {
      // The cluster went away mid-check. Not a refusal: a selection must not be
      // rejected because the cluster was briefly unreachable, and the collect
      // intersects with what is really there on every pass regardless.
      //
      // Where an unclassified per-database failure lands too, deliberately (#345).
      // `unreadable` REFUSES the save, so only a failure we have actually
      // recognised as "no access" may go in it — anything else would reject a
      // legitimate selection over a blip. It used to be dropped on the floor
      // instead, which reported the database as neither absent nor unreadable and
      // saved clean into a blind spot.
      return none;
    } finally {
      lease.release();
    }
  }

  async discardProposalsOutsideScope(
    clusterId: string,
    observed: readonly string[] | null,
  ): Promise<number> {
    return this.repository.discardProposalsOutsideScope(clusterId, observed);
  }

  async setObservedDatabases(
    orgId: string,
    clusterId: string,
    databases: string[] | null,
    errors: NotFound,
  ): Promise<ClusterRow> {
    const row = await this.repository.setObservedDatabases(clusterId, orgId, databases);
    if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
    return row;
  }

  async assertNameFree(orgId: string, name: string, errors: BadRequest): Promise<void> {
    if (await this.repository.nameTaken(orgId, name)) {
      throw errors.BAD_REQUEST({ message: duplicateNameMessage(name) });
    }
  }
}

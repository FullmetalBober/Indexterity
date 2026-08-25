import { Injectable } from "@nestjs/common";
import type { Cluster } from "@repo/contracts";
import type { RequestActor } from "../audit/http-actor";
import { recordSecurityEvent } from "../audit/security-events";
import { DatabaseService } from "../db/database.service";
import { DatabaseInaccessibleError } from "../engine/ports";
import { revokeCommandFor } from "../engine/provision";
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
          if (error instanceof DatabaseInaccessibleError) unreadable.push(database);
        }
      }
      return { absent, unreadable };
    } catch {
      // The cluster went away mid-check. Not a refusal: a selection must not be
      // rejected because the cluster was briefly unreachable, and the collect
      // intersects with what is really there on every pass regardless.
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

import { Controller, Logger, Req } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { actorFromRequest } from "../audit/http-actor";
import { recordSecurityEvent, type SecurityEventDetails } from "../audit/security-events";
import { currentKeyVersion, masterKeyBytesFor } from "../config/env";
import {
  and,
  clusters,
  desc,
  envKeyProvider,
  eq,
  inArray,
  indexSnapshots,
  ne,
  notInArray,
  recommendations,
  seal,
  sql,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { allowPrivateTargets, assertTargetsAllowed, BlockedTargetError } from "../engine/net-guard";
import {
  DatabaseInaccessibleError,
  NO_TLS_OVERRIDES,
  type ProvisionedUser,
  type TlsOverrides,
} from "../engine/ports";
import {
  adapterFor,
  detectEngine,
  engineSupported,
  supportedEngineOptions,
  supportedEngines,
} from "../engine/registry";
import { consumeDialBudget } from "../errors/dial-budget";
import { mapClusterError, toCluster, toDiagnosis } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { ClusterGoneError, openClusterSession } from "../jobs/cluster-connection";
import { evictCluster } from "../jobs/connection-pool";
import { InsecureConnectionError, ProvisionDeniedError } from "../mongo";
import { Implement, route } from "../orpc/implement";
import { restoreHiddenIndexes, revokeCommandFor } from "./offboard";

const CLUSTER_NAME_CONSTRAINT = "clusters_org_name";

// `clusters_org_name` refused the write: this org already has a cluster by that
// name (db/schema.ts). Postgres reports it on the driver's error rather than
// through anything drizzle models, and the constraint is named in the schema
// precisely so this check can be about that one rule instead of "some unique
// index somewhere on clusters".
//
// Caught as well as pre-checked with a SELECT: two writers racing on the same
// name would both find nothing and both go ahead, and the constraint is the only
// answer that cannot lose that race.
//
// Walks the cause chain, because drizzle wraps what the driver threw — the pg
// error with `code`/`constraint` on it is the cause of a DrizzleQueryError, not
// the error itself. Reading the top-level object only was a 500 for a duplicate
// name, which is the failure this function exists to prevent.
function isDuplicateClusterName(error: unknown): boolean {
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

function duplicateNameMessage(name: string): string {
  return `this organization already has a cluster called "${name}" — pick another name`;
}

// Connecting, diagnosing, rotating and disconnecting customer clusters — the
// endpoints that dial a host the user named. Owner-only throughout.
@Controller()
export class ClustersController {
  private readonly log = new Logger(ClustersController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
  ) {}

  private async storeCluster(
    orgId: string,
    name: string,
    engine: typeof clusters.$inferSelect.engine,
    connectionString: string,
    provisionedUsername: string | null,
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
          provisionedUsername,
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

  // Refuse a name the org is already using, BEFORE anything is dialed.
  //
  // The constraint is what actually enforces it, and it is caught at the insert
  // too — but only as the backstop for two connects racing. Asking first is what
  // keeps a collision from being discovered after `provisionCluster` has created
  // a user on somebody's cluster, which nothing would then clean up.
  // `exceptClusterId` is the cluster being renamed: a rename that keeps the name
  // is a no-op, not a collision with itself.
  private async assertNameFree(
    orgId: string,
    name: string,
    errors: { BAD_REQUEST: (options: { message: string }) => Error },
    exceptClusterId?: string,
  ): Promise<void> {
    const [taken] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(
        and(
          eq(clusters.orgId, orgId),
          eq(clusters.name, name),
          ...(exceptClusterId === undefined ? [] : [ne(clusters.id, exceptClusterId)]),
        ),
      )
      .limit(1);
    if (taken !== undefined) throw errors.BAD_REQUEST({ message: duplicateNameMessage(name) });
  }

  // One row in the security trail for something done to a cluster's access
  // (#53). Connecting, disconnecting, rotating credentials and flipping the mode
  // are all owner-level acts on somebody's production database, and until now
  // only the index pipeline left any record — `actions` covers what the engine
  // did and nothing about who let it.
  //
  // After the act, never in front of it, and it cannot fail the request:
  // recordSecurityEvent logs a lost row instead of throwing (see its comment).
  private async record(req: FastifyRequest, entry: SecurityEventDetails): Promise<void> {
    const actor = await actorFromRequest(this.database.db, req);
    await recordSecurityEvent(this.database.db, { ...entry, ...actor }, (message) =>
      this.log.warn(message),
    );
  }

  // Everything that must be true before the control plane dials a customer
  // host: a supported engine, a mongodb scheme, a per-user budget, and a
  // target that is not somewhere on our own network (the wiki's Architecture
  // page, Security). Every endpoint that opens a connection goes through here.
  private async guardDial(
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
    // The enforcement itself lives in mongo/client.ts, because the worker never
    // comes through here: jobs/connection-pool.ts opens the STORED string. This
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

  // Onboarding preflight: what can these credentials actually do? Nothing is
  // stored and nothing is written on the customer cluster — the dashboard uses
  // this to name missing privileges, or to offer creating a scoped user when
  // the credentials are privileged enough.
  @Implement(contract.listClusters)
  listClusters(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listClusters, req, "session").handler(
      async ({ context }) => {
        // Empty rather than an error for a caller who is in no organization yet:
        // this is one of the three reads the dashboard shell makes before it knows
        // what to draw, and a 403 there would render "the api is unreachable" to
        // someone whose api is fine and who simply has no org. `session`, not
        // `member`, for exactly that reason.
        const orgId = context.member?.orgId ?? null;
        if (orgId === null) return [];
        const rows = await this.database.db
          .select()
          .from(clusters)
          .where(eq(clusters.orgId, orgId))
          .orderBy(desc(clusters.createdAt));
        // One grouped query for freshness rather than one per cluster.
        //
        // max(last_seen_at), not max(captured_at): a cluster whose indexes are all
        // idle stops writing new rows and only extends the ones it has, so
        // captured_at would freeze at the last time anything changed and the
        // dashboard would report a healthy cluster as last collected weeks ago.
        const freshness = await this.database.db
          .select({
            clusterId: indexSnapshots.clusterId,
            lastCollectedAt: sql<Date | null>`max(${indexSnapshots.lastSeenAt})`,
          })
          .from(indexSnapshots)
          .where(
            inArray(
              indexSnapshots.clusterId,
              rows.map((row) => row.id),
            ),
          )
          .groupBy(indexSnapshots.clusterId);
        const lastByCluster = new Map(
          freshness.map((entry) => [
            entry.clusterId,
            entry.lastCollectedAt === null ? null : new Date(entry.lastCollectedAt),
          ]),
        );
        return rows.map((row) => toCluster(row, lastByCluster.get(row.id) ?? null));
      },
    );
  }

  // What this build can connect (#239). No tenant data and no org in the answer,
  // so it is the loosest level any of these routes runs at — a signed-in reader
  // asking what the product supports. Deliberately not public: it names the
  // engines an installation carries, and the connect page is behind sign-in
  // anyway, so there is nothing to gain by answering strangers.
  @Implement(contract.listSupportedEngines)
  listSupportedEngines(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listSupportedEngines, req, "session").handler(() =>
      supportedEngineOptions(),
    );
  }

  @Implement(contract.checkConnection)
  checkConnection(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.checkConnection, req, "owner").handler(
      async ({ input, errors, context }) => {
        await this.tenancy.requireOwner(req);
        // An explicit engine wins; otherwise the string itself says (mongodb:// vs
        // mssql:// vs ADO Server=… are disjoint), so the web form needs no
        // engine picker to connect a SQL Server. MONGODB last, for strings
        // nothing claims — its adapter then refuses with the right hint.
        const engine = input.engine ?? detectEngine(input.connectionString) ?? "MONGODB";
        const adapter = adapterFor(engine);
        // The checkboxes are applied to the string BEFORE anything looks at it, so
        // the preflight answers for the connection that would actually be stored
        // rather than for the one that was typed.
        const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
        const value = adapter.applySecureTransport(input.connectionString, overrides);
        await this.guardDial(context.userId, engine, value, errors, overrides);
        // The scope reaches the adapter, so a second check with fewer databases
        // ticked can turn a privilege gap into a grant (#244) — see the field's
        // comment in inputs.ts. Absent on the first check, which has no list yet.
        return toDiagnosis(
          engine,
          await adapter.diagnose(value, overrides, input.observedDatabases),
        );
      },
    );
  }

  @Implement(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.createCluster, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        // Before the dial, not after: refusing on the plan should not first spend
        // several seconds connecting to a cluster we are not going to keep. Same
        // for the name.
        await this.tenancy.requireRoomFor(orgId, "clusters");
        await this.assertNameFree(orgId, input.name, errors);
        // An explicit engine wins; otherwise the string itself says (mongodb:// vs
        // mssql:// vs ADO Server=… are disjoint), so the web form needs no
        // engine picker to connect a SQL Server. MONGODB last, for strings
        // nothing claims — its adapter then refuses with the right hint.
        const engine = input.engine ?? detectEngine(input.connectionString) ?? "MONGODB";
        const adapter = adapterFor(engine);
        const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
        const value = adapter.applySecureTransport(input.connectionString, overrides);
        await this.guardDial(context.userId, engine, value, errors, overrides);
        // Verify before storing: an unusable string must fail at connect time
        // with the reason, not silently collect nothing for a day.
        const diagnosis = await adapter.diagnose(value, overrides, input.observedDatabases);
        // A selection naming a database this cluster does not have is refused here
        // rather than stored and quietly intersected away by every collect: the
        // reader picked from a list we gave them, so a name that is not on it means
        // the cluster changed under them or the caller is scripted and wrong. Both
        // are worth a sentence at connect time.
        const absent = (input.observedDatabases ?? []).filter(
          (name) => !diagnosis.databases.includes(name),
        );
        if (diagnosis.reachable && absent.length > 0) {
          throw errors.BAD_REQUEST({
            message:
              `this cluster has no database called ${absent.join(", ")} — ` +
              `it reports ${diagnosis.databases.join(", ") || "none"}.`,
          });
        }
        if (!diagnosis.reachable) {
          throw new ORPCError("CLUSTER_UNREACHABLE", {
            status: 502,
            message: diagnosis.message ?? "cluster unreachable",
          });
        }
        if (!diagnosis.ready) {
          throw errors.BAD_REQUEST({
            message:
              `these credentials are missing: ${diagnosis.missing.join(", ")}. ` +
              "Grant them, or connect with credentials that can create users and let " +
              "Indexterity provision a scoped one.",
          });
        }
        const row = await this.storeCluster(
          orgId,
          input.name,
          engine,
          value,
          null,
          // Read off the diagnosis rather than the string: whether credentials
          // can create users is a question only the server can answer.
          diagnosis.canProvision ? "ADMIN" : "SCOPED",
          overrides,
          input.observedDatabases ?? null,
        );
        await this.record(req, {
          event: "CLUSTER_CONNECTED",
          orgId,
          clusterId: row.id,
          target: row.name,
          // Which concessions were made and whether we are holding somebody's own
          // credentials — the two facts an incident asks about a connection.
          metadata: {
            engine,
            provisioned: false,
            tlsOverrides: overrides,
            observedDatabases: input.observedDatabases ?? null,
          },
        });
        return toCluster(row);
      },
    );
  }

  // Admin-string onboarding: the admin credentials are used once to create a
  // least-privilege user + role on the customer cluster, then discarded — only
  // the scoped user's string is sealed and stored.
  @Implement(contract.provisionCluster)
  provisionCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.provisionCluster, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        // Before creating a user on someone's cluster, not after.
        await this.tenancy.requireRoomFor(orgId, "clusters");
        await this.assertNameFree(orgId, input.name, errors);
        // The string says which engine this is, exactly as createCluster reads
        // it — so an admin SQL Server string provisions a scoped login instead
        // of being dialled as mongo. An engine whose adapter cannot provision
        // is refused here rather than part way through. An explicit engine wins
        // for the same reason it does on the other two: the reader who overrode
        // detection to get a diagnosis presses this button next, and re-deciding
        // here would provision against a different engine than they were shown.
        const engine = input.engine ?? detectEngine(input.adminConnectionString) ?? "MONGODB";
        const adapter = adapterFor(engine);
        const provision = adapter.provisionScopedUser;
        if (!adapter.capabilities.provisionScopedUsers || provision === undefined) {
          throw errors.BAD_REQUEST({
            message:
              `${engine} cannot provision a scoped user — connect with credentials that ` +
              "already have what the engine needs instead.",
          });
        }
        const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
        const adminValue = adapter.applySecureTransport(input.adminConnectionString, overrides);
        await this.guardDial(context.userId, engine, adminValue, errors, overrides);
        let provisioned: ProvisionedUser;
        try {
          // No selection passed, on purpose: what the provisioned user may reach is
          // not what we choose to observe (#244, and the port's own comment). The
          // selection is stored on the row below and applies to every collect;
          // narrowing the GRANTS would make it un-editable, because there is no
          // admin string left afterwards to widen them with.
          provisioned = await provision(adminValue, overrides);
        } catch (error) {
          if (error instanceof ProvisionDeniedError) {
            throw new ORPCError("PROVISION_DENIED", { status: 422, message: error.message });
          }
          mapClusterError(error);
        }
        const row = await this.storeCluster(
          orgId,
          input.name,
          engine,
          provisioned.connectionString,
          provisioned.username,
          // Known exactly here, unlike either other case: Indexterity created
          // this user, so its ceiling is the scoped role and nothing more.
          "PROVISIONED",
          overrides,
          input.observedDatabases ?? null,
        );
        await this.record(req, {
          event: "CLUSTER_CONNECTED",
          orgId,
          clusterId: row.id,
          target: row.name,
          // The username, never the string: this row is read by people who are not
          // meant to be able to dial the cluster from it.
          metadata: {
            engine,
            provisioned: true,
            provisionedUsername: provisioned.username,
            tlsOverrides: overrides,
            observedDatabases: input.observedDatabases ?? null,
          },
        });
        return {
          cluster: toCluster(row),
          username: provisioned.username,
          connectionString: provisioned.connectionString,
        };
      },
    );
  }

  // Owner-only credential rotation: the new string is dialed and pinged BEFORE
  // it replaces the stored one (a typo must not brick the cluster), then the
  // pooled connection is evicted so the old credentials stop being used
  // immediately. History (snapshots, ROI, audit) survives — this is the
  // alternative to disconnect + reconnect.
  @Implement(contract.rotateConnection)
  rotateConnection(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.rotateConnection, req, "freshOwner").handler(
      async ({ input, errors, context }) => {
        // `freshOwner`, not merely owner: this replaces the credentials the
        // engine dials the customer's cluster with (#52).
        const orgId = context.member.orgId;
        const [row] = await this.database.db
          .select()
          .from(clusters)
          .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
          .limit(1);
        if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        const adapter = adapterFor(row.engine);
        // Unstated on a rotation means "as before": rotating a password should not
        // silently withdraw a concession the cluster still needs to connect at all.
        const overrides = input.tlsOverrides ?? row.tlsOverrides;
        const value = adapter.applySecureTransport(input.connectionString, overrides);
        await this.guardDial(context.userId, row.engine, value, errors, overrides);
        try {
          const probe = await adapter.open(value, overrides);
          try {
            await probe.ping();
          } finally {
            await probe.close();
          }
        } catch (error) {
          mapClusterError(error);
        }
        const keyVersion = currentKeyVersion();
        const sealed = await seal(
          new TextEncoder().encode(input.connectionString),
          envKeyProvider(masterKeyBytesFor(keyVersion)),
        );
        // The scoped-user marker only survives if the new string still
        // authenticates as that user; anything else is a user we didn't create.
        const provisionedUsername =
          row.provisionedUsername !== null &&
          adapter.connStringUsername(input.connectionString) === row.provisionedUsername
            ? row.provisionedUsername
            : null;
        // Re-evaluated here because rotating is exactly when it changes: swapping
        // an admin string for a scoped one is a narrowing somebody should be able
        // to see happened, and the reverse is a widening they should see too.
        //
        // A diagnosis that fails leaves it NULL rather than failing the rotation
        // or keeping the old value. The rotation itself already succeeded — the
        // string pinged — and recording "we no longer know" is honest where
        // carrying forward a posture measured on different credentials is not.
        const credentialPosture =
          provisionedUsername !== null
            ? "PROVISIONED"
            : await adapter
                .diagnose(value, overrides)
                .then((diagnosis) =>
                  diagnosis.canProvision ? ("ADMIN" as const) : ("SCOPED" as const),
                )
                .catch(() => null);
        const [updated] = await this.database.db
          .update(clusters)
          .set({
            sealedDek: Buffer.from(sealed.dek),
            sealedData: Buffer.from(sealed.data),
            keyVersion,
            provisionedUsername,
            credentialPosture,
          })
          .where(eq(clusters.id, input.clusterId))
          .returning();
        if (updated === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        await evictCluster(input.clusterId);
        await this.record(req, {
          event: "CLUSTER_CREDENTIALS_ROTATED",
          orgId,
          clusterId: updated.id,
          target: updated.name,
          // Whether the cluster is still running as a user we created, which is what
          // decides who can revoke that access afterwards.
          metadata: {
            provisionedUsername,
            keptScopedUser: provisionedUsername !== null,
            tlsOverrides: overrides,
          },
        });
        return toCluster(updated);
      },
    );
  }

  // Owner-only offboarding: leave the customer's cluster as we found it
  // (un-hide anything still parked in the observe window — restoration runs
  // even on read-only clusters), drop the pooled connection, delete the row
  // (cascade wipes snapshots, recommendations, actions, ROI, policy, cooldowns,
  // latency samples), and hand back the command to revoke the provisioned user.
  @Implement(contract.deleteCluster)
  deleteCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.deleteCluster, req, "freshOwner").handler(
      async ({ input, errors, context }) => {
        // `freshOwner`, not merely owner: everything collected is deleted and
        // cannot be re-collected as it was (#52).
        const orgId = context.member.orgId;
        const [row] = await this.database.db
          .select()
          .from(clusters)
          .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
          .limit(1);
        if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        const unhidden = await restoreHiddenIndexes(this.database.db, input.clusterId);
        await this.database.db.delete(clusters).where(eq(clusters.id, input.clusterId));
        // `clusterId` stays null here and the id goes in the metadata: the row it
        // would point at has just been deleted, and this event is the one that has
        // to outlive it — everything else about that cluster is gone.
        await this.record(req, {
          event: "CLUSTER_DISCONNECTED",
          orgId,
          target: row.name,
          metadata: {
            clusterId: row.id,
            unhidden,
            provisionedUsername: row.provisionedUsername,
          },
        });
        return { unhidden, revokeCommand: revokeCommandFor(row.provisionedUsername) };
      },
    );
  }

  // Owner-only rename. A plain update of one column, and the only way there has
  // ever been to correct a name: before this, the sole route to a different one
  // was disconnect and reconnect, which deletes every snapshot, recommendation,
  // ROI figure and audit row the cluster had. A cluster observed for three months
  // could not be renamed at any acceptable price (#96).
  //
  // Nothing on the customer's cluster is affected — the provisioned user is
  // derived from the admin connection string, never from this name.
  @Implement(contract.renameCluster)
  renameCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.renameCluster, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        await this.assertNameFree(orgId, input.name, errors, input.clusterId);
        let row: typeof clusters.$inferSelect | undefined;
        try {
          [row] = await this.database.db
            .update(clusters)
            .set({ name: input.name })
            .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
            .returning();
        } catch (error) {
          if (isDuplicateClusterName(error)) {
            throw errors.BAD_REQUEST({ message: duplicateNameMessage(input.name) });
          }
          throw error;
        }
        // Scoped to the org in the WHERE, so another tenant's cluster is not found
        // rather than renamed — the same shape as mode and rotation next door.
        if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        return toCluster(row);
      },
    );
  }

  // Owner-only: flip a cluster between read-only and live mode.
  @Implement(contract.setClusterMode)
  setClusterMode(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.setClusterMode, req, "owner").handler(
      async ({ input, errors, context }) => {
        // `owner` is the floor and the escalation stays here, because which of
        // the two applies is a fact about the INPUT rather than about the route:
        // going live is the moment the engine gains permission to write, so it
        // takes a fresh sign-in, and the way BACK to read-only deliberately does
        // not — an emergency stop that waits on a password re-prompt is not an
        // emergency stop (#52).
        if (!input.readOnly) await this.tenancy.requireFreshOwner(req);
        const orgId = context.member.orgId;
        const [row] = await this.database.db
          .update(clusters)
          .set({ readOnly: input.readOnly })
          .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
          .returning();
        if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        await this.record(req, {
          event: "CLUSTER_MODE_CHANGED",
          orgId,
          clusterId: row.id,
          target: row.name,
          metadata: { readOnly: input.readOnly },
        });
        return toCluster(row);
      },
    );
  }

  // The databases this cluster HAS, for the screen that picks which of them to
  // observe (#244).
  //
  // Dials the cluster on a GET, which is unusual here and is the point: the whole
  // reason this route exists is to offer a database that appeared after
  // onboarding, and nothing we have collected can know about one we have never
  // looked at. The lease is `allDatabases`, so the answer is what the cluster has
  // rather than what we are already watching.
  //
  // No dial budget is spent, unlike the onboarding routes. That budget exists to
  // stop one account sweeping arbitrary hosts (errors/dial-budget.ts); this dials
  // a string the org already connected and the guard already vetted, and charging
  // it would let a settings page a reader opens twice exhaust the allowance that
  // protects the connect form.
  @Implement(contract.listClusterDatabases)
  listClusterDatabases(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listClusterDatabases, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        await this.tenancy.assertOwnsCluster(input.clusterId, orgId, errors);
        let lease: Awaited<ReturnType<typeof openClusterSession>>;
        try {
          lease = await openClusterSession(this.database.db, input.clusterId, {
            allDatabases: true,
          });
        } catch (error) {
          if (error instanceof ClusterGoneError) {
            throw errors.NOT_FOUND({ message: "cluster not found" });
          }
          mapClusterError(error);
        }
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
      },
    );
  }

  // Replace which databases the collect walks.
  //
  // `owner` rather than `freshOwner`, which is the line rotation, going live and
  // disconnecting are all on the other side of. Those three change what the
  // control plane HOLDS or lets the engine WRITE; this changes how much of a
  // cluster the org already connected we read, with credentials that could already
  // read all of it. Recorded in the security trail either way, because widening it
  // is how we start reading a database we were not reading yesterday.
  @Implement(contract.setObservedDatabases)
  setObservedDatabases(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.setObservedDatabases, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        const [row] = await this.database.db
          .select()
          .from(clusters)
          .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
          .limit(1);
        if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        // Checked against the cluster rather than against what we have collected,
        // for the same reason the GET above dials: a name that is only wrong
        // because we have never observed it is exactly the name this route exists
        // to accept.
        if (input.databases !== null) {
          // Only what is being ADDED is probed for access, so narrowing a cluster
          // never waits on a per-database round trip.
          const added = input.databases.filter(
            (name) => row.observedDatabases !== null && !row.observedDatabases.includes(name),
          );
          const { absent, unreadable } = await this.unusableDatabases(
            input.clusterId,
            input.databases,
            added,
            errors,
          );
          if (absent.length > 0) {
            throw errors.BAD_REQUEST({
              message:
                `this cluster has no database called ${absent.join(", ")} — ` +
                "reload the list and pick again.",
            });
          }
          // Refused at the tick rather than accepted into a blind spot. The credentials
          // stored for this cluster cannot read these databases at all, so observing
          // them would collect nothing from them forever and say so nowhere.
          //
          // Provisioning is not narrowed to the selection (#244), so this is no longer
          // about the boxes somebody ticked at connect time — it is the residual gap
          // that decision leaves: provisioning grants per database and runs once, so a
          // database CREATED afterwards has no user for the login and no admin string
          // survives to give it one. Hence the message names both ways out.
          if (unreadable.length > 0) {
            throw errors.BAD_REQUEST({
              message:
                `these credentials cannot read ${unreadable.join(", ")} on this cluster` +
                (row.provisionedUsername === null
                  ? ". Grant them access and try again."
                  : ` — ${row.provisionedUsername} was granted in the databases that existed when ` +
                    "it was created, and the admin string it was made with is never stored, so a " +
                    "database created since then has no user for it. Grant it there yourself, or " +
                    "rotate to a connection string that already has access."),
            });
          }
        }
        // Proposals for a database that just left the selection, discarded before
        // the column is written: an approval that fires between the two would act
        // on a database the owner has already said to leave alone.
        //
        // Only the states where nothing has happened on the customer's cluster
        // yet. HIDDEN, OBSERVE and BUILDING are excluded deliberately — the engine
        // has already changed something there, the row is the only record of it,
        // and offboard.ts reads exactly those states to put it back. Dropping them
        // would leave an index hidden on a database nobody is watching, with
        // nothing left that knows to unhide it.
        const discarded = await this.discardProposalsOutsideScope(input.clusterId, input.databases);
        const [updated] = await this.database.db
          .update(clusters)
          .set({ observedDatabases: input.databases })
          .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
          .returning();
        if (updated === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
        await this.record(req, {
          event: "CLUSTER_OBSERVED_DATABASES_CHANGED",
          orgId,
          clusterId: updated.id,
          target: updated.name,
          metadata: {
            from: row.observedDatabases,
            to: input.databases,
            discardedRecommendations: discarded,
          },
        });
        return toCluster(updated);
      },
    );
  }

  // Which of these names the cluster does not have. Empty when it has them all,
  // and empty when the cluster cannot be reached to say — a selection must not be
  // refused because the cluster was briefly down, and the filter in
  // jobs/cluster-connection.ts intersects on every collect regardless, so a name
  // that turns out to be wrong costs nothing but its own absence.
  private async unusableDatabases(
    clusterId: string,
    wanted: readonly string[],
    added: readonly string[],
    errors: { NOT_FOUND: (options: { message: string }) => Error },
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

  // Delete the open proposals whose database is no longer observed, and return how
  // many. Nothing is deleted when the selection is null (every database is in
  // scope) or when it only grew.
  private async discardProposalsOutsideScope(
    clusterId: string,
    observed: readonly string[] | null,
  ): Promise<number> {
    if (observed === null) return 0;
    const discarded = await this.database.db
      .delete(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          inArray(recommendations.state, ["PROPOSED", "APPROVED", "SCHEDULED"]),
          notInArray(recommendations.database, [...observed]),
        ),
      )
      .returning({ id: recommendations.id });
    return discarded.length;
  }

  @Implement(contract.triggerCollect)
  triggerCollect(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.triggerCollect, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        await this.tenancy.assertOwnsCluster(input.clusterId, orgId, errors);
        // Hand it to the worker rather than dialling the cluster here. A collect
        // walks every collection and can take minutes on a large one; the
        // dashboard polls for the result instead of holding the request open.
        await this.database.db.execute(
          sql`select graphile_worker.add_job('collect', json_build_object('clusterId', ${input.clusterId}::text), max_attempts => 3)`,
        );
        return { queued: true };
      },
    );
  }
}

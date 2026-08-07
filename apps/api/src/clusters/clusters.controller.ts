import { Controller, Logger, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import { ORPCError } from "@orpc/server";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { requireUserId } from "../auth/session";
import { and, clusters, desc, envKeyProvider, eq, inArray, indexSnapshots, seal, sql } from "../db";
import { DatabaseService } from "../db/database.service";
import { allowPrivateTargets, assertTargetsAllowed, BlockedTargetError } from "../engine/net-guard";
import { NO_TLS_OVERRIDES, type TlsOverrides } from "../engine/ports";
import { adapterFor, engineSupported } from "../engine/registry";
import { currentKeyVersion, masterKeyBytesFor } from "../env";
import { consumeDialBudget } from "../errors/dial-budget";
import { mapClusterError, toCluster, toDiagnosis } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { evictCluster } from "../jobs/connection-pool";
import {
  connStringUsername,
  InsecureConnectionError,
  ProvisionDeniedError,
  provisionScopedUser,
} from "../mongo";
import { Implement } from "../orpc/implement";
import { restoreHiddenIndexes, revokeCommandFor } from "./offboard";

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
    tlsOverrides: TlsOverrides = NO_TLS_OVERRIDES,
  ): Promise<typeof clusters.$inferSelect> {
    const keyVersion = currentKeyVersion();
    const sealed = await seal(
      new TextEncoder().encode(connectionString),
      envKeyProvider(masterKeyBytesFor(keyVersion)),
    );
    const [row] = await this.database.db
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
        tlsOverrides,
      })
      .returning();
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
  private async guardDial(
    req: FastifyRequest,
    engine: typeof clusters.$inferSelect.engine,
    value: string,
    errors: { BAD_REQUEST: (options: { message: string }) => Error },
    overrides: TlsOverrides = NO_TLS_OVERRIDES,
  ): Promise<void> {
    if (!engineSupported(engine)) {
      throw errors.BAD_REQUEST({
        message: `${engine} support is planned — only MONGODB clusters can connect today`,
      });
    }
    const adapter = adapterFor(engine);
    if (!adapter.isConnString(value)) {
      throw errors.BAD_REQUEST({
        message: "connection string must be mongodb:// or mongodb+srv://",
      });
    }
    await consumeDialBudget(this.database.db, await requireUserId(req));
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
    return implement(contract.listClusters).handler(async () => {
      // Empty rather than an error for a caller who is in no organization yet:
      // this is one of the three reads the dashboard shell makes before it knows
      // what to draw, and a 403 there would render "the api is unreachable" to
      // someone whose api is fine and who simply has no org.
      const orgId = await this.tenancy.orgOrNull(req);
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
    });
  }

  @Implement(contract.checkConnection)
  checkConnection(@Req() req: FastifyRequest) {
    return implement(contract.checkConnection).handler(async ({ input, errors }) => {
      await this.tenancy.requireOwner(req);
      const engine = input.engine ?? "MONGODB";
      const adapter = adapterFor(engine);
      // The checkboxes are applied to the string BEFORE anything looks at it, so
      // the preflight answers for the connection that would actually be stored
      // rather than for the one that was typed.
      const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
      const value = adapter.applySecureTransport(input.connectionString, overrides);
      await this.guardDial(req, engine, value, errors, overrides);
      return toDiagnosis(await adapter.diagnose(value, overrides));
    });
  }

  @Implement(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return implement(contract.createCluster).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      // Before the dial, not after: refusing on the plan should not first spend
      // several seconds connecting to a cluster we are not going to keep.
      await this.tenancy.requireRoomFor(orgId, "clusters");
      const engine = input.engine ?? "MONGODB";
      const adapter = adapterFor(engine);
      const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
      const value = adapter.applySecureTransport(input.connectionString, overrides);
      await this.guardDial(req, engine, value, errors, overrides);
      // Verify before storing: an unusable string must fail at connect time
      // with the reason, not silently collect nothing for a day.
      const diagnosis = await adapter.diagnose(value, overrides);
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
      return toCluster(await this.storeCluster(orgId, input.name, engine, value, null, overrides));
    });
  }

  // Admin-string onboarding: the admin credentials are used once to create a
  // least-privilege user + role on the customer cluster, then discarded — only
  // the scoped user's string is sealed and stored.
  @Implement(contract.provisionCluster)
  provisionCluster(@Req() req: FastifyRequest) {
    return implement(contract.provisionCluster).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      // Before creating a user on someone's cluster, not after.
      await this.tenancy.requireRoomFor(orgId, "clusters");
      // Provisioning is engine-specific; MONGODB is the only adapter with the
      // capability today (see EngineCapabilities.provisionScopedUsers).
      const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
      const adminValue = adapterFor("MONGODB").applySecureTransport(
        input.adminConnectionString,
        overrides,
      );
      await this.guardDial(req, "MONGODB", adminValue, errors, overrides);
      let provisioned: Awaited<ReturnType<typeof provisionScopedUser>>;
      try {
        provisioned = await provisionScopedUser(adminValue, overrides);
      } catch (error) {
        if (error instanceof ProvisionDeniedError) {
          throw new ORPCError("PROVISION_DENIED", { status: 422, message: error.message });
        }
        mapClusterError(error);
      }
      const row = await this.storeCluster(
        orgId,
        input.name,
        "MONGODB",
        provisioned.connectionString,
        provisioned.username,
        overrides,
      );
      return {
        cluster: toCluster(row),
        username: provisioned.username,
        connectionString: provisioned.connectionString,
      };
    });
  }

  // Owner-only credential rotation: the new string is dialed and pinged BEFORE
  // it replaces the stored one (a typo must not brick the cluster), then the
  // pooled connection is evicted so the old credentials stop being used
  // immediately. History (snapshots, ROI, audit) survives — this is the
  // alternative to disconnect + reconnect.
  @Implement(contract.rotateConnection)
  rotateConnection(@Req() req: FastifyRequest) {
    return implement(contract.rotateConnection).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
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
      await this.guardDial(req, row.engine, value, errors, overrides);
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
        connStringUsername(input.connectionString) === row.provisionedUsername
          ? row.provisionedUsername
          : null;
      const [updated] = await this.database.db
        .update(clusters)
        .set({
          sealedDek: Buffer.from(sealed.dek),
          sealedData: Buffer.from(sealed.data),
          keyVersion,
          provisionedUsername,
        })
        .where(eq(clusters.id, input.clusterId))
        .returning();
      if (updated === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
      await evictCluster(input.clusterId);
      return toCluster(updated);
    });
  }

  // Owner-only offboarding: leave the customer's cluster as we found it
  // (un-hide anything still parked in the observe window — restoration runs
  // even on read-only clusters), drop the pooled connection, delete the row
  // (cascade wipes snapshots, recommendations, actions, ROI, policy, cooldowns,
  // latency samples), and hand back the command to revoke the provisioned user.
  @Implement(contract.deleteCluster)
  deleteCluster(@Req() req: FastifyRequest) {
    return implement(contract.deleteCluster).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      const [row] = await this.database.db
        .select()
        .from(clusters)
        .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
        .limit(1);
      if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
      const unhidden = await restoreHiddenIndexes(this.database.db, input.clusterId);
      await this.database.db.delete(clusters).where(eq(clusters.id, input.clusterId));
      return { unhidden, revokeCommand: revokeCommandFor(row.provisionedUsername) };
    });
  }

  // Owner-only: flip a cluster between read-only and live mode.
  @Implement(contract.setClusterMode)
  setClusterMode(@Req() req: FastifyRequest) {
    return implement(contract.setClusterMode).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      const [row] = await this.database.db
        .update(clusters)
        .set({ readOnly: input.readOnly })
        .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
        .returning();
      if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
      return toCluster(row);
    });
  }

  @Implement(contract.triggerCollect)
  triggerCollect(@Req() req: FastifyRequest) {
    return implement(contract.triggerCollect).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      // Hand it to the worker rather than dialling the cluster here. A collect
      // walks every collection and can take minutes on a large one; the
      // dashboard polls for the result instead of holding the request open.
      await this.database.db.execute(
        sql`select graphile_worker.add_job('collect', json_build_object('clusterId', ${input.clusterId}::text), max_attempts => 3)`,
      );
      return { queued: true };
    });
  }
}

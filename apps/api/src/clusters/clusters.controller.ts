import { Controller, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import { ORPCError } from "@orpc/server";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { requireUserId } from "../auth/session";
import {
  and,
  clusters,
  desc,
  envKeyProvider,
  eq,
  inArray,
  indexSnapshots,
  recommendations,
  seal,
  sql,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { allowPrivateTargets, assertTargetsAllowed, BlockedTargetError } from "../engine/net-guard";
import { adapterFor, engineSupported } from "../engine/registry";
import { currentKeyVersion, masterKeyBytesFor } from "../env";
import { consumeDialBudget } from "../errors/dial-budget";
import { mapClusterError, toCluster, toDiagnosis } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { openClusterSession } from "../jobs/cluster-connection";
import { evictCluster } from "../jobs/connection-pool";
import { connStringUsername, ProvisionDeniedError, provisionScopedUser } from "../mongo";
import { Implement } from "../orpc/implement";

// Connecting, diagnosing, rotating and disconnecting customer clusters — the
// endpoints that dial a host the user named. Owner-only throughout.
@Controller()
export class ClustersController {
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
      })
      .returning();
    if (row === undefined) throw new Error("failed to create cluster");
    return row;
  }

  // Everything that must be true before the control plane dials a customer
  // host: a supported engine, a mongodb scheme, a per-user budget, and a
  // target that is not somewhere on our own network (docs/architecture.md
  // §10.2). Every endpoint that opens a connection goes through here.
  private async guardDial(
    req: FastifyRequest,
    engine: typeof clusters.$inferSelect.engine,
    value: string,
    errors: { BAD_REQUEST: (options: { message: string }) => Error },
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
  }

  // Onboarding preflight: what can these credentials actually do? Nothing is
  // stored and nothing is written on the customer cluster — the dashboard uses
  // this to name missing privileges, or to offer creating a scoped user when
  // the credentials are privileged enough.
  @Implement(contract.listClusters)
  listClusters(@Req() req: FastifyRequest) {
    return implement(contract.listClusters).handler(async () => {
      const orgId = await this.tenancy.org(req);
      const rows = await this.database.db
        .select()
        .from(clusters)
        .where(eq(clusters.orgId, orgId))
        .orderBy(desc(clusters.createdAt));
      // One grouped query for freshness rather than one per cluster.
      const freshness = await this.database.db
        .select({
          clusterId: indexSnapshots.clusterId,
          lastCollectedAt: sql<Date | null>`max(${indexSnapshots.capturedAt})`,
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
      await this.guardDial(req, engine, input.connectionString, errors);
      return toDiagnosis(await adapterFor(engine).diagnose(input.connectionString));
    });
  }

  @Implement(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return implement(contract.createCluster).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      const engine = input.engine ?? "MONGODB";
      await this.guardDial(req, engine, input.connectionString, errors);
      // Verify before storing: an unusable string must fail at connect time
      // with the reason, not silently collect nothing for a day.
      const diagnosis = await adapterFor(engine).diagnose(input.connectionString);
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
      return toCluster(
        await this.storeCluster(orgId, input.name, engine, input.connectionString, null),
      );
    });
  }

  // Admin-string onboarding: the admin credentials are used once to create a
  // least-privilege user + role on the customer cluster, then discarded — only
  // the scoped user's string is sealed and stored.
  @Implement(contract.provisionCluster)
  provisionCluster(@Req() req: FastifyRequest) {
    return implement(contract.provisionCluster).handler(async ({ input, errors }) => {
      const orgId = await this.tenancy.requireOwner(req);
      // Provisioning is engine-specific; MONGODB is the only adapter with the
      // capability today (see EngineCapabilities.provisionScopedUsers).
      await this.guardDial(req, "MONGODB", input.adminConnectionString, errors);
      let provisioned: Awaited<ReturnType<typeof provisionScopedUser>>;
      try {
        provisioned = await provisionScopedUser(input.adminConnectionString);
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
      await this.guardDial(req, row.engine, input.connectionString, errors);
      try {
        const probe = await adapter.open(input.connectionString);
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
      const inFlight = await this.database.db
        .select()
        .from(recommendations)
        .where(
          and(
            eq(recommendations.clusterId, input.clusterId),
            inArray(recommendations.state, ["HIDDEN", "OBSERVE"]),
          ),
        );
      let unhidden = 0;
      if (inFlight.length > 0) {
        try {
          const { session, release } = await openClusterSession(this.database.db, input.clusterId);
          try {
            const executor = session.executor(false);
            for (const rec of inFlight) {
              try {
                await executor.unhide(rec.database, rec.collection, rec.indexName);
                unhidden += 1;
              } catch {
                // index already gone — nothing to restore
              }
            }
          } finally {
            release();
          }
        } catch {
          // cluster unreachable: offboarding still proceeds
        }
      }
      await evictCluster(input.clusterId);
      await this.database.db.delete(clusters).where(eq(clusters.id, input.clusterId));
      return {
        unhidden,
        revokeCommand:
          row.provisionedUsername === null
            ? null
            : `db.getSiblingDB("admin").dropUser("${row.provisionedUsername}")`,
      };
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

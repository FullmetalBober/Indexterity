import { Controller, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import { ORPCError } from "@orpc/server";
import { type Cluster, contract, type Recommendation, type RoiContribution } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type LatencyReading,
  latencyPoints,
  monthlySavingsUsd,
  parseStoredSpec,
  rebuildKeys,
  summarizeLatency,
} from "../analysis";
import { requireUserId } from "../auth/session";
import { type Membership, resolveMembership } from "../auth/tenancy";
import {
  actions,
  and,
  clusters,
  desc,
  envKeyProvider,
  eq,
  inArray,
  indexSnapshots,
  latencySamples,
  policies,
  recommendations,
  roiMetrics,
  seal,
  sql,
} from "../db";
import { DatabaseService } from "../db/database.service";
import { allowPrivateTargets, assertTargetsAllowed, BlockedTargetError } from "../engine/net-guard";
import type { ConnectionDiagnosis as EngineConnectionDiagnosis } from "../engine/ports";
import { adapterFor, engineSupported } from "../engine/registry";
import { currentKeyVersion, masterKeyBytesFor } from "../env";
import { consumeDialBudget } from "../errors/dial-budget";
import { isUnreachableError } from "../errors/unreachable";
import { openClusterSession } from "../jobs/cluster-connection";
import { evictCluster } from "../jobs/connection-pool";
import { recordManualVeto } from "../jobs/cooldowns";
import { connStringUsername, ProvisionDeniedError, provisionScopedUser } from "../mongo";
import { Implement } from "../orpc/implement";

// How long a cancelled drop stays off the table before the engine may propose
// it again — long enough that an owner is not re-rejecting the same row weekly.
const VETO_COOLDOWN_DAYS = 90;

// A drop's rollback token carries the dropped index's serialized spec.
const rollbackTokenSchema = z.object({ spec: z.unknown() });

// oRPC handles handler throws itself (Nest filters never see them), so the
// customer-cluster failure mapping lives here: unreachable -> 502 with guidance.
function mapClusterError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  const err = error instanceof Error ? error : new Error(String(error));
  if (isUnreachableError(err)) {
    throw new ORPCError("CLUSTER_UNREACHABLE", {
      status: 502,
      message: "cluster unreachable — check the connection string and network access",
    });
  }
  if (err.message.startsWith("cluster not found")) {
    throw new ORPCError("NOT_FOUND", { message: "cluster not found" });
  }
  throw err;
}

// The domain type carries readonly arrays; the contract's output schema wants
// plain ones. Copy at the boundary rather than loosening the domain type.
function toDiagnosis(diagnosis: EngineConnectionDiagnosis) {
  return {
    ...diagnosis,
    privileges: [...diagnosis.privileges],
    missing: [...diagnosis.missing],
  };
}

function toCluster(
  row: typeof clusters.$inferSelect,
  lastCollectedAt: Date | null = null,
): Cluster {
  return {
    id: row.id,
    name: row.name,
    connectionMode: row.connectionMode,
    engine: row.engine,
    readOnly: row.readOnly,
    provisionedUsername: row.provisionedUsername,
    lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRecommendation(row: typeof recommendations.$inferSelect): Recommendation {
  return {
    id: row.id,
    clusterId: row.clusterId,
    type: row.type,
    usageClass: row.usageClass,
    state: row.state,
    database: row.database,
    collection: row.collection,
    indexName: row.indexName,
    rationale: row.rationale,
    score: row.score,
    estimatedBytesSaved: row.estimatedBytesSaved,
    createdAt: row.createdAt.toISOString(),
  };
}

// Serves the shared oRPC contract from Postgres. Every endpoint requires a
// better-auth session and is scoped to the caller's org.
@Controller()
export class RecommendationsController {
  constructor(private readonly database: DatabaseService) {}

  // Authn + tenancy: 401 without a valid session, else the caller's membership.
  private async resolveMember(req: FastifyRequest): Promise<Membership> {
    return resolveMembership(this.database.db, await requireUserId(req));
  }

  private async resolveOrg(req: FastifyRequest): Promise<string> {
    return (await this.resolveMember(req)).orgId;
  }

  // Mutations (connect cluster, mode, approve, undo, collect) are owner-only;
  // members read everything.
  private async requireOwner(req: FastifyRequest): Promise<string> {
    const member = await this.resolveMember(req);
    if (member.role !== "owner") {
      throw new ORPCError("FORBIDDEN", { message: "owner role required" });
    }
    return member.orgId;
  }

  private async ownsCluster(clusterId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(and(eq(clusters.id, clusterId), eq(clusters.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }

  private async loadLatencyReadings(
    clusterId: string,
  ): Promise<Map<string, { database: string; collection: string; readings: LatencyReading[] }>> {
    const rows = await this.database.db
      .select()
      .from(latencySamples)
      .where(eq(latencySamples.clusterId, clusterId));
    const groups = new Map<
      string,
      { database: string; collection: string; readings: LatencyReading[] }
    >();
    for (const row of rows) {
      const key = `${row.database} ${row.collection}`;
      const group = groups.get(key) ?? {
        database: row.database,
        collection: row.collection,
        readings: [],
      };
      group.readings.push({
        readOps: row.readOps,
        readLatencyMicros: row.readLatencyMicros,
        writeOps: row.writeOps,
        writeLatencyMicros: row.writeLatencyMicros,
        capturedAt: row.capturedAt.toISOString(),
      });
      groups.set(key, group);
    }
    return groups;
  }

  @Implement(contract.listClusters)
  listClusters(@Req() req: FastifyRequest) {
    return implement(contract.listClusters).handler(async () => {
      const orgId = await this.resolveOrg(req);
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

  @Implement(contract.listRecommendations)
  listRecommendations(@Req() req: FastifyRequest) {
    return implement(contract.listRecommendations).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) return [];
      const rows = await this.database.db
        .select()
        .from(recommendations)
        .where(eq(recommendations.clusterId, input.clusterId));
      return rows.map(toRecommendation);
    });
  }

  @Implement(contract.getRoi)
  getRoi(@Req() req: FastifyRequest) {
    return implement(contract.getRoi).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        return {
          clusterId: input.clusterId,
          freedBytes: 0,
          indexesDropped: 0,
          estimatedMonthlyUsd: 0,
          attribution: [],
        };
      }
      const rows = await this.database.db
        .select()
        .from(roiMetrics)
        .where(eq(roiMetrics.clusterId, input.clusterId));
      // Undo corrections insert negative rows; the headline never goes below zero.
      const freedBytes = Math.max(
        0,
        rows.reduce((sum, row) => sum + row.freedBytes, 0),
      );
      const indexesDropped = Math.max(
        0,
        rows.reduce((sum, row) => sum + row.indexCountDelta, 0),
      );
      const envRate = Number(process.env.STORAGE_USD_PER_GB_MONTH);
      const rate = Number.isFinite(envRate) && envRate > 0 ? envRate : undefined;
      // Attribution: net freed bytes per recommendation (drop rows minus undo
      // rows), positive contributors only, biggest first.
      const net = new Map<string, number>();
      for (const row of rows) {
        if (row.recommendationId === null) continue;
        net.set(row.recommendationId, (net.get(row.recommendationId) ?? 0) + row.freedBytes);
      }
      const contributors = [...net.entries()]
        .filter(([, bytes]) => bytes > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      let attribution: RoiContribution[] = [];
      if (contributors.length > 0) {
        const recRows = await this.database.db
          .select()
          .from(recommendations)
          .where(
            inArray(
              recommendations.id,
              contributors.map(([id]) => id),
            ),
          );
        const byId = new Map(recRows.map((rec) => [rec.id, rec]));
        attribution = contributors.flatMap(([id, bytes]) => {
          const rec = byId.get(id);
          if (rec === undefined) return [];
          return [
            {
              recommendationId: id,
              database: rec.database,
              collection: rec.collection,
              indexName: rec.indexName,
              freedBytes: bytes,
              estimatedMonthlyUsd: monthlySavingsUsd(bytes, rate),
            },
          ];
        });
      }
      return {
        clusterId: input.clusterId,
        freedBytes,
        indexesDropped,
        estimatedMonthlyUsd: monthlySavingsUsd(freedBytes, rate),
        attribution,
      };
    });
  }

  @Implement(contract.getLatency)
  getLatency(@Req() req: FastifyRequest) {
    return implement(contract.getLatency).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        return { clusterId: input.clusterId, collections: [] };
      }
      const groups = await this.loadLatencyReadings(input.clusterId);
      const collections = [...groups.values()].map((group) => ({
        database: group.database,
        collection: group.collection,
        ...summarizeLatency(group.readings),
      }));
      return { clusterId: input.clusterId, collections };
    });
  }

  @Implement(contract.getLatencySeries)
  getLatencySeries(@Req() req: FastifyRequest) {
    return implement(contract.getLatencySeries).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        return { clusterId: input.clusterId, collections: [] };
      }
      const groups = await this.loadLatencyReadings(input.clusterId);
      const collections = [...groups.values()].map((group) => ({
        database: group.database,
        collection: group.collection,
        points: latencyPoints(group.readings),
      }));
      return { clusterId: input.clusterId, collections };
    });
  }

  // Per-collection index footprint from the latest snapshot batch (one collect
  // run inserts all its rows in a single statement, so they share a timestamp).
  @Implement(contract.getCollections)
  getCollections(@Req() req: FastifyRequest) {
    return implement(contract.getCollections).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        return { clusterId: input.clusterId, collections: [] };
      }
      // The max(captured_at) comparison must stay in SQL: pg keeps microseconds
      // and a JS Date round-trip truncates to ms, so re-querying by an equal
      // Date would match nothing.
      const snapshotRows = await this.database.db
        .select()
        .from(indexSnapshots)
        .where(
          and(
            eq(indexSnapshots.clusterId, input.clusterId),
            sql`${indexSnapshots.capturedAt} = (select max(${indexSnapshots.capturedAt}) from ${indexSnapshots} where ${indexSnapshots.clusterId} = ${input.clusterId})`,
          ),
        );
      const proposedRows = await this.database.db
        .select({ database: recommendations.database, collection: recommendations.collection })
        .from(recommendations)
        .where(
          and(
            eq(recommendations.clusterId, input.clusterId),
            eq(recommendations.state, "PROPOSED"),
          ),
        );
      const proposedByNs = new Map<string, number>();
      for (const rec of proposedRows) {
        const key = `${rec.database} ${rec.collection}`;
        proposedByNs.set(key, (proposedByNs.get(key) ?? 0) + 1);
      }
      const byNs = new Map<
        string,
        { database: string; collection: string; indexCount: number; totalIndexBytes: number }
      >();
      for (const row of snapshotRows) {
        const key = `${row.database} ${row.collection}`;
        const group = byNs.get(key) ?? {
          database: row.database,
          collection: row.collection,
          indexCount: 0,
          totalIndexBytes: 0,
        };
        group.indexCount += 1;
        group.totalIndexBytes += row.sizeBytes;
        byNs.set(key, group);
      }
      const collections = [...byNs.entries()]
        .map(([key, group]) => ({
          ...group,
          proposedRecommendations: proposedByNs.get(key) ?? 0,
        }))
        .sort((a, b) => b.totalIndexBytes - a.totalIndexBytes);
      return { clusterId: input.clusterId, collections };
    });
  }

  @Implement(contract.listActions)
  listActions(@Req() req: FastifyRequest) {
    return implement(contract.listActions).handler(async ({ input }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) return [];
      const rows = await this.database.db
        .select({
          id: actions.id,
          kind: actions.kind,
          actor: actions.actor,
          result: actions.result,
          database: recommendations.database,
          collection: recommendations.collection,
          indexName: recommendations.indexName,
          createdAt: actions.createdAt,
        })
        .from(actions)
        .innerJoin(recommendations, eq(actions.recommendationId, recommendations.id))
        .where(eq(recommendations.clusterId, input.clusterId))
        .orderBy(desc(actions.createdAt))
        .limit(50);
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    });
  }

  // Seal a connection string and insert the cluster row (read-only by default).
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
  @Implement(contract.checkConnection)
  checkConnection(@Req() req: FastifyRequest) {
    return implement(contract.checkConnection).handler(async ({ input, errors }) => {
      await this.requireOwner(req);
      const engine = input.engine ?? "MONGODB";
      await this.guardDial(req, engine, input.connectionString, errors);
      return toDiagnosis(await adapterFor(engine).diagnose(input.connectionString));
    });
  }

  @Implement(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return implement(contract.createCluster).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
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
      const orgId = await this.requireOwner(req);
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
      const orgId = await this.requireOwner(req);
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
      const orgId = await this.requireOwner(req);
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
      const orgId = await this.requireOwner(req);
      const [row] = await this.database.db
        .update(clusters)
        .set({ readOnly: input.readOnly })
        .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, orgId)))
        .returning();
      if (row === undefined) throw errors.NOT_FOUND({ message: "cluster not found" });
      return toCluster(row);
    });
  }

  @Implement(contract.getPolicy)
  getPolicy(@Req() req: FastifyRequest) {
    return implement(contract.getPolicy).handler(async ({ input, errors }) => {
      const orgId = await this.resolveOrg(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      const [row] = await this.database.db
        .select()
        .from(policies)
        .where(eq(policies.clusterId, input.clusterId))
        .limit(1);
      return {
        clusterId: input.clusterId,
        workloadAnalysis: row?.workloadAnalysis ?? false,
        instantCreate: row?.instantCreate ?? false,
        observeWindowDays: row?.observeWindowDays ?? 30,
        maxCollectionSizeBytes: row?.maxCollectionSizeBytes ?? null,
        autoApplyScore: row?.autoApplyScore ?? null,
        changeWindowStartHour: row?.changeWindowStartHour ?? null,
        changeWindowEndHour: row?.changeWindowEndHour ?? null,
        inferredWindowStartHour: row?.inferredWindowStartHour ?? null,
        inferredWindowEndHour: row?.inferredWindowEndHour ?? null,
        inferredWindowReason: row?.inferredWindowReason ?? null,
      };
    });
  }

  // Owner-only: replace the cluster's engine knobs.
  @Implement(contract.updatePolicy)
  updatePolicy(@Req() req: FastifyRequest) {
    return implement(contract.updatePolicy).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const { clusterId, ...knobs } = input;
      if (!(await this.ownsCluster(clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      const [saved] = await this.database.db
        .insert(policies)
        .values({ clusterId, ...knobs })
        .onConflictDoUpdate({ target: policies.clusterId, set: knobs })
        .returning();
      // Echo the engine's window back too — clearing the explicit one hands
      // the choice back to the engine, and the UI needs to say so immediately.
      return {
        clusterId,
        ...knobs,
        inferredWindowStartHour: saved?.inferredWindowStartHour ?? null,
        inferredWindowEndHour: saved?.inferredWindowEndHour ?? null,
        inferredWindowReason: saved?.inferredWindowReason ?? null,
      };
    });
  }

  @Implement(contract.triggerCollect)
  triggerCollect(@Req() req: FastifyRequest) {
    return implement(contract.triggerCollect).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      if (!(await this.ownsCluster(input.clusterId, orgId))) {
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

  @Implement(contract.approveRecommendation)
  approveRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.approveRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const [owned] = await this.database.db
        .select({ id: recommendations.id })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      const [row] = await this.database.db
        .update(recommendations)
        .set({ state: "APPROVED", updatedAt: new Date() })
        .where(eq(recommendations.id, input.id))
        .returning();
      if (row === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      return toRecommendation(row);
    });
  }

  // Undo a drop: rebuild the index from the spec captured at drop time, correct
  // the ROI headline with a negative row, and mark the recommendation ROLLED_BACK.
  @Implement(contract.rollbackRecommendation)
  rollbackRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.rollbackRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const [owned] = await this.database.db
        .select({ rec: recommendations })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1);
      if (owned === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      const rec = owned.rec;
      if (rec.state !== "DROPPED") {
        throw errors.CONFLICT({ message: "only a dropped index can be undone" });
      }
      const dropActions = await this.database.db
        .select()
        .from(actions)
        .where(and(eq(actions.recommendationId, rec.id), eq(actions.kind, "DROP")))
        .orderBy(desc(actions.createdAt));
      const withToken = dropActions.find((action) => action.rollbackToken !== null);
      if (withToken === undefined || withToken.rollbackToken === null) {
        throw errors.CONFLICT({ message: "no rollback token recorded for this drop" });
      }
      let keys: Record<string, 1 | -1> | null = null;
      let indexName = rec.indexName;
      let collation: string | null = null;
      try {
        const spec = parseStoredSpec(rollbackTokenSchema.parse(withToken.rollbackToken).spec);
        keys = rebuildKeys(spec);
        indexName = spec.name;
        collation = spec.collation;
      } catch {
        keys = null;
      }
      if (keys === null) {
        throw errors.CONFLICT({ message: "stored spec cannot be rebuilt automatically" });
      }
      try {
        const { session, readOnly, release } = await openClusterSession(
          this.database.db,
          rec.clusterId,
        );
        try {
          if (readOnly) {
            throw errors.CONFLICT({ message: "cluster is read-only" });
          }
          const executor = session.executor(readOnly);
          await executor.create(rec.database, rec.collection, keys, {
            name: indexName,
            ...(collation === null ? {} : { collation: { locale: collation } }),
          });
        } finally {
          release();
        }
      } catch (error) {
        mapClusterError(error);
      }
      // The freed bytes are spent again — correct the ROI headline, attributed
      // so the per-index list nets this recommendation back out.
      await this.database.db.insert(roiMetrics).values({
        clusterId: rec.clusterId,
        recommendationId: rec.id,
        freedBytes: -rec.estimatedBytesSaved,
        indexCountDelta: -1,
        periodStart: new Date(),
        periodEnd: new Date(),
      });
      const [updated] = await this.database.db
        .update(recommendations)
        .set({ state: "ROLLED_BACK", updatedAt: new Date() })
        .where(eq(recommendations.id, rec.id))
        .returning();
      if (updated === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      await this.database.db.insert(actions).values({
        recommendationId: rec.id,
        kind: "ROLLBACK",
        actor: "user",
        result: "ok",
      });
      return toRecommendation(updated);
    });
  }

  // Owner-only: cancel a pending drop while the index is still hidden.
  //
  // Until now the only ways out of HIDDEN were automatic — the regression gate,
  // a counter reset, a failed pre-flight — or disconnecting the cluster. An
  // owner who simply knew the index was needed had to wait out the window.
  @Implement(contract.unhideRecommendation)
  unhideRecommendation(@Req() req: FastifyRequest) {
    return implement(contract.unhideRecommendation).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwner(req);
      const [rec] = await this.database.db
        .select({ rec: recommendations })
        .from(recommendations)
        .innerJoin(clusters, eq(recommendations.clusterId, clusters.id))
        .where(and(eq(recommendations.id, input.id), eq(clusters.orgId, orgId)))
        .limit(1)
        .then((rows) => rows.map((row) => row.rec));
      if (rec === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      if (rec.state !== "HIDDEN") {
        throw errors.CONFLICT({ message: "only a hidden index can be un-hidden" });
      }

      try {
        const { session, readOnly, release } = await openClusterSession(
          this.database.db,
          rec.clusterId,
        );
        try {
          if (readOnly) throw errors.CONFLICT({ message: "cluster is read-only" });
          await session.executor(readOnly).unhide(rec.database, rec.collection, rec.indexName);
        } finally {
          release();
        }
      } catch (error) {
        mapClusterError(error);
      }

      // Park it, so the next classify pass does not propose the same drop
      // straight back. Not counted as a regression — nothing regressed, an
      // owner just knows something the engine does not.
      const until = await recordManualVeto(
        this.database.db,
        rec.clusterId,
        { database: rec.database, collection: rec.collection, indexName: rec.indexName },
        VETO_COOLDOWN_DAYS,
        "drop cancelled by an owner",
      );
      const day = until.toISOString().slice(0, 10);
      const [updated] = await this.database.db
        .update(recommendations)
        .set({
          state: "REJECTED",
          hiddenAt: null,
          observeDays: null,
          baselineReadOps: null,
          baselineReadLatency: null,
          rationale: `${rec.rationale} — cancelled by an owner; not re-proposed until ${day}`,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id))
        .returning();
      if (updated === undefined) {
        throw errors.NOT_FOUND({ message: "recommendation not found" });
      }
      await this.database.db.insert(actions).values({
        recommendationId: rec.id,
        kind: "HIDE",
        actor: "user",
        result: `un-hidden on request; cooling down until ${day}`,
      });
      return toRecommendation(updated);
    });
  }
}

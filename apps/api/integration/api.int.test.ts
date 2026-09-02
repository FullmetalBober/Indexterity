import type { ChildProcess } from "node:child_process";
import {
  CLUSTER_INDEXES_PAGE,
  LATENCY_SERIES_MAX_COLLECTIONS,
  LATENCY_SERIES_WINDOW_DAYS,
  RECOMMENDATIONS_CAP,
  SECURITY_TRAIL_PAGE,
  WORKLOAD_SHAPES_PAGE,
} from "@repo/contracts";
import { makeWorkerUtils } from "graphile-worker";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { judgeFailures } from "../src/analysis";
import { outcomeOf } from "../src/analysis/workload-outcome";
import { entitledAutomation } from "../src/billing/plans";
import { loadEnv } from "../src/config/env";
import {
  account,
  actions,
  analysisNotes,
  and,
  clusterIndexes,
  clusters,
  createDatabase,
  desc,
  eq,
  inArray,
  indexCooldowns,
  indexSnapshots,
  latencySamples,
  members,
  organizations,
  orgPolicies,
  policies,
  recommendations,
  roiMetrics,
  securityEvents,
  session,
  sql,
  user,
  verification,
  workloadShapes,
} from "../src/db";
import { workloadKey } from "../src/engine/ports";
import { SCOPED_USERNAME } from "../src/engine/provision";
import { applyCluster, promoteByScore } from "../src/jobs/apply";
import { refreshInferredWindow } from "../src/jobs/change-window";
import { classifyCluster } from "../src/jobs/classify";
import { openClusterSession } from "../src/jobs/cluster-connection";
import { collectCluster } from "../src/jobs/collect";
import { pendingBuildsByCollection } from "../src/jobs/collection-budget";
import { drainPool } from "../src/jobs/connection-pool";
import { activeCooldownKeys, cooldownKey } from "../src/jobs/cooldowns";
import { applyCreatesForCluster } from "../src/jobs/create";
import { finalizeCluster } from "../src/jobs/finalize";
import { releaseStaleLocks } from "../src/jobs/locks";
import { planForCluster } from "../src/jobs/plan";
import { latestBaselines } from "../src/jobs/probe";
import { pruneDeadLetterJobs, pruneOldSamples } from "../src/jobs/retention";
import { suggestForCluster } from "../src/jobs/suggest";
import { isScanning } from "../src/jobs/workload-shapes";
import { MongoConnection, MongoIndexCollector } from "../src/mongo";
import { hasQueryStatsPlanMetrics, parseServerVersion } from "../src/mongo/version";
import {
  API_BASE,
  API_PORT,
  api,
  asRecord,
  asRecords,
  asString,
  asStrings,
  authPost,
  createOrg,
  databaseUrl,
  insertLatency,
  insertSnapshots,
  MONGO_URL,
  type Session,
  sessionFrom,
  signUp,
  signUpWithoutOrg,
  startApi,
  stopApi,
  WEB_ORIGIN,
} from "./helpers";
import { secretFromTotpUri, totpCode } from "./totp";

// fetch().json() is unknown — narrow at the boundary, no `as`.
let server: ChildProcess;
let db: ReturnType<typeof createDatabase>;
let mongo: MongoConnection;
let owner: Session;
let ownerOrgId: string;
let member: Session;
let switcher: Session;
let clusterId: string;

const createdEmails: string[] = [];
const createdClusterIds: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  server = await startApi();
  db = createDatabase(databaseUrl(), 2);
  mongo = new MongoConnection(MONGO_URL);
  await mongo.connect();
  // Setup, not just teardown. A run that dies before afterAll leaves indexes
  // and collections behind, and every test that reads "whatever is on the
  // server" then passes on that debris — which is how this suite came to
  // require a long-lived mongo and to fail against a fresh one.
  await mongo
    .db("inttest")
    .dropDatabase()
    .catch(() => {});
  // One seeded collection, so the first collect has something to find. Tests
  // must not depend on a later test having run first.
  await mongo
    .db("inttest")
    .collection("orders")
    .insertMany(Array.from({ length: 50 }, (_, i) => ({ status: i % 3, qty: i })));
  owner = await signUp("owner");
  createdEmails.push(owner.email);
  // This suite is about the engine, not billing: it connects several clusters
  // to one org, which no free plan would allow. The plan limits have their own
  // tests below, on their own orgs, at their own plans.
  ownerOrgId = await giveRoom(owner);
});

// Move a session's org onto the top plan, so quota is never what a test fails
// on unless that is the test.
async function giveRoom(session: Session): Promise<string> {
  const orgId = asString(asRecord(await (await api("/org", session)).json()).id);
  await db.update(organizations).set({ plan: "SCALE" }).where(eq(organizations.id, orgId));
  return orgId;
}

afterAll(async () => {
  // The change-window test ran job code in THIS process — release its pools. The
  // job code no longer opens one of its own: it runs against the `db` this suite
  // created, which is closed with the rest of the teardown below.
  await drainPool();
  // Before the orgs and accounts go, not after. Every foreign key on
  // `security_events` is `set null` on purpose — deleting an org must not erase
  // the trail of what was done to it — so rows deleted by cascade is exactly what
  // does NOT happen, and the suite has to remove its own debris while it can
  // still recognise it.
  if (createdOrgIds.length > 0) {
    await db
      .delete(securityEvents)
      .where(inArray(securityEvents.orgId, createdOrgIds))
      .catch(() => {});
  }
  if (createdEmails.length > 0) {
    await db
      .delete(securityEvents)
      .where(inArray(securityEvents.actorEmail, createdEmails))
      .catch(() => {});
    await db
      .delete(securityEvents)
      .where(inArray(securityEvents.target, createdEmails))
      .catch(() => {});
  }
  for (const id of createdClusterIds) {
    await db
      .delete(clusters)
      .where(eq(clusters.id, id))
      .catch(() => {});
  }
  for (const id of createdOrgIds) {
    await db
      .delete(organizations)
      .where(eq(organizations.id, id))
      .catch(() => {});
  }
  if (createdEmails.length > 0) {
    await db
      .delete(user)
      .where(inArray(user.email, createdEmails))
      .catch(() => {});
  }
  await mongo
    .db("inttest")
    .dropDatabase()
    .catch(() => {});
  await mongo.close();
  await db.$client.end();
  await stopApi(server);
});

describe("authn and SSRF guard", () => {
  it("rejects unauthenticated data requests with 401", async () => {
    const res = await api("/clusters", null);
    expect(res.status).toBe(401);
  });

  it("rejects non-mongodb connection strings with 400", async () => {
    const res = await api("/clusters", owner, {
      method: "POST",
      body: JSON.stringify({ name: "evil", connectionString: "http://169.254.169.254/latest" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("cluster lifecycle", () => {
  it("connects a cluster in read-only mode", async () => {
    const res = await api("/clusters", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Int Cluster", connectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.readOnly).toBe(true);
    clusterId = asString(body.id);
    createdClusterIds.push(clusterId);
  });

  // Connecting a cluster and then waiting up to six hours for the dashboard to
  // say anything is what reads as "the collect cadence is too long". One job on
  // connect answers it without changing the steady-state load, and the queue is
  // the only place that is observable.
  it("queues the first collect on connect rather than waiting for the schedule", async () => {
    // `_private_jobs` rather than the `jobs` view: the view does not expose the
    // payload, and the payload is the only place the cluster is named.
    const queued = await db.execute(
      sql`select count(*)::int as n
          from graphile_worker._private_jobs j
          join graphile_worker._private_tasks t on t.id = j.task_id
          where t.identifier = 'collect'
            and j.payload->>'clusterId' = ${clusterId}`,
    );
    expect(Number(asRecord(queued.rows[0] ?? {}).n)).toBeGreaterThan(0);
  });

  it("owner flips the cluster live", async () => {
    const live = await api(`/clusters/${clusterId}/mode`, owner, {
      method: "PATCH",
      body: JSON.stringify({ readOnly: false }),
    });
    expect(live.status).toBe(200);
    expect(asRecord(await live.json()).readOnly).toBe(false);
  });

  it("rotates the connection string only after verifying it", async () => {
    // A dead target must be rejected before anything is stored.
    const dead = await api(`/clusters/${clusterId}/connection`, owner, {
      method: "PATCH",
      body: JSON.stringify({ connectionString: "mongodb://127.0.0.1:59999" }),
    });
    expect(dead.status).toBe(502);
    const badScheme = await api(`/clusters/${clusterId}/connection`, owner, {
      method: "PATCH",
      body: JSON.stringify({ connectionString: "http://example.com" }),
    });
    expect(badScheme.status).toBe(400);
    // A reachable string replaces the stored one; collect keeps working on it.
    // MONGO_URL, not a literal: this cluster is shared by every test below, so
    // hardcoding a host here silently repoints the whole suite at that server
    // and nothing downstream can be run against any other one.
    const rotated = await api(`/clusters/${clusterId}/connection`, owner, {
      method: "PATCH",
      body: JSON.stringify({ connectionString: MONGO_URL }),
    });
    expect(rotated.status).toBe(200);
    // Run the job directly: the endpoint only queues now, so a 200 from it
    // would prove a row was inserted, not that the new string dials.
    expect(await collectCluster(db, clusterId)).toBeGreaterThan(0);
    const queued = await api(`/clusters/${clusterId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(queued.status).toBe(200);
    expect(asRecord(await queued.json()).queued).toBe(true);
  });

  // The roster (#100): the collect that just ran recorded which nodes it saw.
  // The suite's mongo is a standalone, so the roster is the one honest row a
  // standalone gets — the multi-member states are covered at the unit level
  // (nodeFromHello, MemberConnections), where a replica set can be faked.
  it("serves the node roster the last collect recorded", async () => {
    const res = await api(`/clusters/${clusterId}/nodes`, owner);
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.collectedAt).not.toBeNull();
    const nodes = asRecords(body.nodes, "body.nodes");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.role).toBe("standalone");
    expect(nodes[0]?.state).toBe("answered");

    // Another tenant's cluster answers empty, the same shape as never collected.
    const stranger = await signUp("nodes-stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const foreign = asRecord(await (await api(`/clusters/${clusterId}/nodes`, stranger)).json());
    expect(foreign.collectedAt).toBeNull();
    expect(foreign.nodes).toEqual([]);
  });

  it("serves policy defaults and round-trips an update", async () => {
    const defaults = asRecord(await (await api(`/clusters/${clusterId}/policy`, owner)).json());
    expect(defaults.observeWindowDays).toBe(30);
    expect(defaults.autoApplyScore).toBeNull();

    const put = await api(`/clusters/${clusterId}/policy`, owner, {
      method: "PUT",
      body: JSON.stringify({
        workloadAnalysis: true,
        instantCreate: false,
        observeWindowDays: 7,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: null,
        changeWindowEndHour: null,
      }),
    });
    expect(put.status).toBe(200);
    const saved = asRecord(await (await api(`/clusters/${clusterId}/policy`, owner)).json());
    expect(saved.observeWindowDays).toBe(7);
    expect(saved.workloadAnalysis).toBe(true);
  });
});

// A name used to be set once, at connect time, and the only route to a different
// one was disconnect + reconnect — which deletes every snapshot, recommendation,
// ROI figure and audit row the cluster had (#96).
//
// Its own account, and not because of tenancy: connecting spends the per-user
// dial budget (10 a minute), and two more connects on the shared `owner` push the
// scenarios below it over the line. A separate session is the cheap way to keep
// this describe from being a 429 somewhere else.
describe("cluster rename", () => {
  let renamer: Session;
  let renameId: string;

  it("connects two clusters, one to rename and one to collide with", async () => {
    renamer = await signUp("renamer");
    createdEmails.push(renamer.email);
    createdOrgIds.push(await giveRoom(renamer));
    for (const name of ["Int Taken", "Int Rename"]) {
      const res = await api("/clusters", renamer, {
        method: "POST",
        body: JSON.stringify({ name, connectionString: MONGO_URL }),
      });
      expect(res.status).toBe(200);
      const id = asString(asRecord(await res.json()).id);
      createdClusterIds.push(id);
      if (name === "Int Rename") renameId = id;
    }
  });

  it("renames it, and the list says so", async () => {
    const res = await api(`/clusters/${renameId}`, renamer, {
      method: "PATCH",
      body: JSON.stringify({ name: "Int Renamed" }),
    });
    expect(res.status).toBe(200);
    expect(asRecord(await res.json()).name).toBe("Int Renamed");

    const list: unknown = await (await api("/clusters", renamer)).json();
    const names = Array.isArray(list) ? list.map((entry) => asRecord(entry).name) : [];
    expect(names).toContain("Int Renamed");
    expect(names).not.toContain("Int Rename");
  });

  // The history is the whole reason this endpoint exists rather than "disconnect
  // and connect again", so the rename has to leave it where it was.
  it("keeps everything collected about the cluster", async () => {
    const collected = await collectCluster(db, renameId);
    expect(collected).toBeGreaterThan(0);
    const before = await db
      .select({ id: indexSnapshots.id })
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, renameId));
    const res = await api(`/clusters/${renameId}`, renamer, {
      method: "PATCH",
      body: JSON.stringify({ name: "Int Renamed Twice" }),
    });
    expect(res.status).toBe(200);
    const after = await db
      .select({ id: indexSnapshots.id })
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, renameId));
    expect(after).toHaveLength(before.length);
  });

  // Two clusters called "staging" are one indistinguishable pair in the sidebar
  // and, worse, in an alert subject line.
  it("refuses a name the org is already using, on rename and on connect", async () => {
    const collision = await api(`/clusters/${renameId}`, renamer, {
      method: "PATCH",
      body: JSON.stringify({ name: "Int Taken" }),
    });
    expect(collision.status).toBe(400);
    expect(asString(asRecord(await collision.json()).message)).toContain("already has a cluster");

    // Same rule at the other door, and refused BEFORE anything is dialed.
    const connect = await api("/clusters", renamer, {
      method: "POST",
      body: JSON.stringify({ name: "Int Taken", connectionString: MONGO_URL }),
    });
    expect(connect.status).toBe(400);
  });

  it("refuses a name that is only whitespace", async () => {
    const blank = await api(`/clusters/${renameId}`, renamer, {
      method: "PATCH",
      body: JSON.stringify({ name: "   " }),
    });
    expect(blank.status).toBe(400);
  });

  // Another tenant's cluster is not found rather than forbidden: whether an id
  // exists is not this caller's to learn.
  it("does not exist for another organization", async () => {
    const outsider = await signUp("outsider");
    createdEmails.push(outsider.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", outsider)).json()).id));
    const res = await api(`/clusters/${renameId}`, outsider, {
      method: "PATCH",
      body: JSON.stringify({ name: "Mine Now" }),
    });
    expect(res.status).toBe(404);
    const list: unknown = await (await api("/clusters", renamer)).json();
    const names = Array.isArray(list) ? list.map((entry) => asRecord(entry).name) : [];
    expect(names).toContain("Int Renamed Twice");
    expect(names).not.toContain("Mine Now");
  });
});

describe("tenancy, invites and roles", () => {
  it("keeps a fresh account isolated", async () => {
    member = await signUp("member");
    createdEmails.push(member.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", member)).json()).id));
    const list: unknown = await (await api("/clusters", member)).json();
    expect(Array.isArray(list) && list.length === 0).toBe(true);
  });

  // Signing up no longer conjures an organization behind the first GET, so this
  // is a real state the api has to answer for rather than a transient one.
  it("answers a member of no organization with emptiness, not an error", async () => {
    const orphan = await signUpWithoutOrg("orphan");
    createdEmails.push(orphan.email);

    const clusters = await api("/clusters", orphan);
    expect(clusters.status).toBe(200);
    expect(await clusters.json()).toEqual([]);
    const orgs = await api("/orgs", orphan);
    expect(orgs.status).toBe(200);
    expect(await orgs.json()).toEqual([]);
    const org = await api("/org", orphan);
    expect(org.status).toBe(200);
    expect(await org.json()).toBeNull();

    // But a mutation says so, rather than inventing somewhere to put it.
    const connect = await api("/clusters", orphan, {
      method: "POST",
      body: JSON.stringify({ name: "Nowhere", connectionString: MONGO_URL }),
    });
    expect(connect.status).toBe(403);
    expect(asString(asRecord(await connect.json()).message)).toContain("create an organization");

    createdOrgIds.push(await createOrg(orphan, "Orphan Org"));
    const after = await api("/org", orphan);
    expect(asRecord(await after.json()).name).toBe("Orphan Org");
  });

  // A plan is bought per organization, so how many you hold is not metered —
  // limiting it would limit how much a customer may buy. What holds the free
  // tier is the cluster cap, applied inside each org one at a time.
  it("does not cap how many organizations one person makes", async () => {
    const many = await signUpWithoutOrg("many-orgs");
    createdEmails.push(many.email);
    createdOrgIds.push(await createOrg(many, "Orgs One"));
    createdOrgIds.push(await createOrg(many, "Orgs Two"));
    createdOrgIds.push(await createOrg(many, "Orgs Three"));

    const orgs = await (await api("/orgs", many)).json();
    expect(Array.isArray(orgs) ? orgs.length : 0).toBe(3);
    // Each lands on the default plan and is metered on its own.
    const org = asRecord(await (await api("/org", many)).json());
    expect(asRecord(org.plan).plan).toBe("FREE");
    expect(asRecord(org.plan).maxClusters).toBe(1);
  });

  it("invites the member into the org, and the invitation is spent once", async () => {
    const inviteRes = await authPost("/organization/invite-member", owner, {
      email: member.email,
      role: "member",
    });
    expect(inviteRes.status).toBe(200);
    const invitationId = asString(asRecord(await inviteRes.json()).id);

    // The invitation is listed to the person it names — the id is not a
    // credential any more, so it can be.
    const mine = await (await api("/invites", member)).json();
    const ids = Array.isArray(mine) ? mine.map((entry) => asRecord(entry).id) : [];
    expect(ids).toContain(invitationId);

    const accept = await authPost("/organization/accept-invitation", member, { invitationId });
    expect(accept.status).toBe(200);

    // Spent: the second attempt finds nothing pending under that id.
    const reuse = await authPost("/organization/accept-invitation", member, { invitationId });
    expect(reuse.status).toBe(400);

    const list: unknown = await (await api("/clusters", member)).json();
    const seesCluster =
      Array.isArray(list) &&
      list.some((entry: unknown) => {
        const record = asRecord(entry);
        return record.id === clusterId;
      });
    expect(seesCluster).toBe(true);
  });

  it("refuses an invitation addressed to somebody else", async () => {
    const stranger = await signUp("stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const inviteRes = await authPost("/organization/invite-member", owner, {
      email: `nobody-${Date.now()}@int.test`,
      role: "member",
    });
    const invitationId = asString(asRecord(await inviteRes.json()).id);
    const stolen = await authPost("/organization/accept-invitation", stranger, { invitationId });
    expect(stolen.status).toBe(403);
  });

  it("blocks members from every mutation (403) but not reads", async () => {
    const mode = await api(`/clusters/${clusterId}/mode`, member, {
      method: "PATCH",
      body: JSON.stringify({ readOnly: true }),
    });
    const rename = await api(`/clusters/${clusterId}`, member, {
      method: "PATCH",
      body: JSON.stringify({ name: "Theirs" }),
    });
    const create = await api("/clusters", member, {
      method: "POST",
      body: JSON.stringify({ name: "nope", connectionString: MONGO_URL }),
    });
    // The plugin's own permission check: the `member` role has no
    // invitation:create, so this is a 403 for the same reason as the rest.
    const invite = await authPost("/organization/invite-member", member, {
      email: "x@int.test",
      role: "member",
    });
    const policy = await api(`/clusters/${clusterId}/policy`, member, {
      method: "PUT",
      body: JSON.stringify({
        workloadAnalysis: false,
        instantCreate: false,
        observeWindowDays: 30,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: null,
        changeWindowEndHour: null,
      }),
    });
    expect([mode.status, rename.status, create.status, invite.status, policy.status]).toEqual([
      403, 403, 403, 403, 403,
    ]);
    const read = await api(`/clusters/${clusterId}/policy`, member);
    expect(read.status).toBe(200);
  });

  it("records the owner's org for cleanup", async () => {
    const org = asRecord(await (await api("/org", owner)).json());
    createdOrgIds.push(asString(org.id));
  });
});

describe("collect, audit trail and undo", () => {
  it("collects snapshots from the live mongo", async () => {
    await mongo
      .db("inttest")
      .collection("orders")
      .insertMany(Array.from({ length: 50 }, (_, i) => ({ status: i % 3, qty: i })));
    // The endpoint queues; the job is what reads the cluster. Run it here so
    // the tests that follow have snapshots to work from.
    const res = await api(`/clusters/${clusterId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(asRecord(await res.json()).queued).toBe(true);
    expect(await collectCluster(db, clusterId)).toBeGreaterThan(0);
  });

  it("summarizes the per-collection index footprint", async () => {
    const res = await api(`/clusters/${clusterId}/collections`, owner);
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const collections = Array.isArray(body.collections) ? body.collections.map(asRecord) : [];
    const orders = collections.find(
      (coll) => coll.database === "inttest" && coll.collection === "orders",
    );
    expect(orders).toBeDefined();
    expect(typeof orders?.indexCount === "number" && orders.indexCount >= 1).toBe(true);
    expect(typeof orders?.totalIndexBytes === "number" && orders.totalIndexBytes > 0).toBe(true);
  });

  it("exposes the audit trail and rebuilds a dropped index on undo", async () => {
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "DROPPED",
        database: "inttest",
        collection: "orders",
        indexName: "old_1",
        rationale: "integration drop",
        estimatedBytesSaved: 4096,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");
    await db.insert(actions).values({
      recommendationId: rec.id,
      kind: "DROP",
      actor: "system",
      result: "ok",
      rollbackToken: {
        spec: {
          name: "old_1",
          keys: [{ field: "old", direction: 1 }],
          unique: false,
          ttl: false,
          partial: false,
          partialFilter: null,
          sparse: false,
          hidden: false,
          isShardKey: false,
        },
      },
    });

    const trail: unknown = await (await api(`/clusters/${clusterId}/actions`, owner)).json();
    const hasDropEntry =
      Array.isArray(trail) &&
      trail.some((entry: unknown) => {
        const record = asRecord(entry);
        return record.kind === "DROP" && record.indexName === "old_1";
      });
    expect(hasDropEntry).toBe(true);

    const undo = await api(`/recommendations/${rec.id}/rollback`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(undo.status).toBe(200);

    // Undo has to outlast one classify tick. The rebuilt index carries the same
    // name, so its pre-drop history still reads "never used" — without a
    // cooldown the engine proposes the identical drop on the next pass, and
    // with an autoApplyScore set it performs it.
    const parked = await activeCooldownKeys(db, clusterId);
    expect(parked.has(cooldownKey("inttest", "orders", "old_1"))).toBe(true);
    const indexes = await mongo.db("inttest").collection("orders").indexes();
    expect(indexes.some((index) => index.name === "old_1")).toBe(true);
  });

  it("attributes reclaimed bytes to their recommendation in the ROI payload", async () => {
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "DROPPED",
        database: "inttest",
        collection: "orders",
        indexName: "attr_test_1",
        rationale: "attribution test",
        estimatedBytesSaved: 8192,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");
    await db.insert(roiMetrics).values({
      clusterId,
      recommendationId: rec.id,
      freedBytes: 8192,
      indexCountDelta: 1,
      periodStart: new Date(),
      periodEnd: new Date(),
    });
    const roi = asRecord(await (await api(`/clusters/${clusterId}/roi`, owner)).json());
    const attribution = Array.isArray(roi.attribution) ? roi.attribution.map(asRecord) : [];
    const entry = attribution.find((item) => item.indexName === "attr_test_1");
    expect(entry?.freedBytes).toBe(8192);
    expect(typeof entry?.estimatedMonthlyUsd).toBe("number");
    // The undone drop from the previous test netted to zero — never listed.
    expect(attribution.some((item) => item.indexName === "old_1")).toBe(false);
  });
});

describe("org switcher", () => {
  it("switches the active org and rescopes every request", async () => {
    switcher = await signUp("switcher");
    createdEmails.push(switcher.email);
    const own = await api("/clusters", switcher, {
      method: "POST",
      body: JSON.stringify({ name: "Switcher Own", connectionString: MONGO_URL }),
    });
    expect(own.status).toBe(200);
    createdClusterIds.push(asString(asRecord(await own.json()).id));
    const ownOrg = asRecord(await (await api("/org", switcher)).json());
    createdOrgIds.push(asString(ownOrg.id));

    const inviteRes = await authPost("/organization/invite-member", owner, {
      email: switcher.email,
      role: "member",
    });
    const invitationId = asString(asRecord(await inviteRes.json()).id);
    const accept = await authPost("/organization/accept-invitation", switcher, { invitationId });
    expect(accept.status).toBe(200);

    // Two orgs now, and accepting an invitation moves you into the org you were
    // invited to — the plugin sets it active, which is what the click meant.
    const ownerOrg = asRecord(await (await api("/org", owner)).json());
    const orgsBody = await (await api("/orgs", switcher)).json();
    const orgList = Array.isArray(orgsBody) ? orgsBody.map(asRecord) : [];
    expect(orgList).toHaveLength(2);
    expect(orgList.find((entry) => entry.active === true)?.orgId).toBe(asString(ownerOrg.id));

    // Every subsequent request is scoped to the switched-to org.
    const clustersAfter = await (await api("/clusters", switcher)).json();
    const names = Array.isArray(clustersAfter)
      ? clustersAfter.map((entry) => asRecord(entry).name)
      : [];
    expect(names).toContain("Int Cluster");
    expect(names).not.toContain("Switcher Own");

    // And back, which is the switcher proper.
    const back = await authPost("/organization/set-active", switcher, {
      organizationId: asString(ownOrg.id),
    });
    expect(back.status).toBe(200);
    const mine = await (await api("/clusters", switcher)).json();
    const myNames = Array.isArray(mine) ? mine.map((entry) => asRecord(entry).name) : [];
    expect(myNames).toContain("Switcher Own");
    expect(myNames).not.toContain("Int Cluster");
  });

  // Deleting an org is the one verb that reaches past our own tables, so it has
  // its own scenario: the rows go, the session that was in it survives.
  it("deletes an org, taking its clusters and leaving the owner able to make another", async () => {
    const deleter = await signUp("deleter");
    createdEmails.push(deleter.email);
    const orgId = asString(asRecord(await (await api("/org", deleter)).json()).id);
    const created = await api("/clusters", deleter, {
      method: "POST",
      body: JSON.stringify({ name: "Doomed Cluster", connectionString: MONGO_URL }),
    });
    expect(created.status).toBe(200);
    const doomedId = asString(asRecord(await created.json()).id);

    const deleted = await authPost("/organization/delete", deleter, { organizationId: orgId });
    expect(deleted.status).toBe(200);

    expect(await db.select().from(clusters).where(eq(clusters.id, doomedId))).toHaveLength(0);
    expect(await db.select().from(organizations).where(eq(organizations.id, orgId))).toHaveLength(
      0,
    );

    // Still signed in, and now in no org at all.
    const org = await api("/org", deleter);
    expect(org.status).toBe(200);
    expect(await org.json()).toBeNull();

    // The free slot came back with it.
    createdOrgIds.push(await createOrg(deleter, "Second Try"));
  });
});

describe("session cookie cache", () => {
  // The two halves of #77 that only show up over real HTTP: an ordinary api
  // response re-arms the cache when resolving the session had to touch
  // postgres, and a request presenting a fresh cache is answered without
  // postgres — demonstrated by deleting the session row underneath it, which
  // is also the revocation trade auth.config.ts signs up for.
  it("re-arms the cache on an ordinary response, then answers from it alone", async () => {
    const rider = await signUpWithoutOrg("cookie-cache");
    createdEmails.push(rider.email);

    // Shed the cache cookie sign-up set, as a browser would at its maxAge.
    rider.cookie = rider.cookie
      .split("; ")
      .filter((pair) => !pair.includes("session_data"))
      .join("; ");

    // The miss falls through to postgres, and the response carries the
    // re-signed cache cookie back — the forwarding under test (main.ts).
    const rearmed = await api("/orgs", rider);
    expect(rearmed.status).toBe(200);
    expect(rider.cookie).toContain("session_data");

    // Revoke behind the browser's back: the row is gone, the cookie answers.
    const [account] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, rider.email));
    await db.delete(session).where(eq(session.userId, asString(account?.id)));
    const cached = await api("/orgs", rider);
    expect(cached.status).toBe(200);

    // Without the cache the token goes back to postgres, which says no.
    rider.cookie = rider.cookie
      .split("; ")
      .filter((pair) => !pair.includes("session_data"))
      .join("; ");
    const refused = await api("/orgs", rider);
    expect(refused.status).toBe(401);
  });
});

describe("fresh session tier", () => {
  // The three acts that change what the engine may do to a customer's database
  // — going live, rotating credentials, disconnecting — refuse an owner session
  // signed in more than SESSION_FRESH_AGE_SECONDS ago (#52). The session is
  // aged here behind the browser's back, the way time does it, and the cache
  // cookie is shed because it still carries the young createdAt it was signed
  // with — a browser at that point re-arms from the aged row on the next reply.
  it("refuses the three sensitive acts on an old session, until a new sign-in", async () => {
    const stale = await signUp("stale-owner");
    createdEmails.push(stale.email);
    const orgId = asString(asRecord(await (await api("/org", stale)).json()).id);
    createdOrgIds.push(orgId);

    const connected = await api("/clusters", stale, {
      method: "POST",
      body: JSON.stringify({ name: "Stale Cluster", connectionString: MONGO_URL }),
    });
    expect(connected.status).toBe(200);
    const staleClusterId = asString(asRecord(await connected.json()).id);
    createdClusterIds.push(staleClusterId);

    const [account] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, stale.email));
    await db
      .update(session)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(eq(session.userId, asString(account?.id)));
    stale.cookie = stale.cookie
      .split("; ")
      .filter((pair) => !pair.includes("session_data"))
      .join("; ");

    // The refusal is its own code, not a bare 403: the dashboard tells an
    // owner who can fix it (sign in again) apart from a member who cannot.
    const live = await api(`/clusters/${staleClusterId}/mode`, stale, {
      method: "PATCH",
      body: JSON.stringify({ readOnly: false }),
    });
    const rotated = await api(`/clusters/${staleClusterId}/connection`, stale, {
      method: "PATCH",
      body: JSON.stringify({ connectionString: MONGO_URL }),
    });
    const deleted = await api(`/clusters/${staleClusterId}`, stale, { method: "DELETE" });
    expect([live.status, rotated.status, deleted.status]).toEqual([403, 403, 403]);
    expect(asRecord(await live.json()).code).toBe("SESSION_NOT_FRESH");

    // De-escalation and the benign mutations ride the ordinary owner check —
    // an emergency stop that waits on a password is not an emergency stop.
    const readOnly = await api(`/clusters/${staleClusterId}/mode`, stale, {
      method: "PATCH",
      body: JSON.stringify({ readOnly: true }),
    });
    const renamed = await api(`/clusters/${staleClusterId}`, stale, {
      method: "PATCH",
      body: JSON.stringify({ name: "Still Reachable" }),
    });
    expect([readOnly.status, renamed.status]).toEqual([200, 200]);

    // Signing in again mints a fresh session row — the api form of the
    // dashboard's re-auth dialog — and the same act goes through.
    const again = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: stale.email, password: "password12345" }),
    });
    expect(again.status).toBe(200);
    const fresh = sessionFrom(stale.email, again);
    const liveNow = await api(`/clusters/${staleClusterId}/mode`, fresh, {
      method: "PATCH",
      body: JSON.stringify({ readOnly: false }),
    });
    expect(liveNow.status).toBe(200);
  });
});

describe("change email", () => {
  // The immediate flow (#83): this instance does not require verification and
  // the account is unverified, so the address flips in the request itself —
  // and the old address stops signing in at the same moment the new one
  // starts. The two-step verified chain is better-auth's own and needs a
  // mailbox; what is proven here is the half the product decided.
  it("moves sign-in to the new address, and the old one stops working", async () => {
    const mover = await signUpWithoutOrg("email-mover");
    createdEmails.push(mover.email);
    const oldEmail = mover.email;
    const newEmail = `moved-${Date.now()}-${Math.floor(Math.random() * 1e6)}@int.test`;
    createdEmails.push(newEmail);

    const changed = await authPost("/change-email", mover, { newEmail });
    expect(changed.status).toBe(200);

    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.email, newEmail));
    expect(row?.email).toBe(newEmail);

    const oldSignIn = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: oldEmail, password: "password12345" }),
    });
    expect(oldSignIn.status).toBe(401);

    const newSignIn = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: newEmail, password: "password12345" }),
    });
    expect(newSignIn.status).toBe(200);
  });

  it("refuses the address the account already has", async () => {
    const same = await signUpWithoutOrg("email-same");
    createdEmails.push(same.email);
    const refused = await authPost("/change-email", same, { newEmail: same.email });
    expect(refused.status).toBe(400);
  });
});

describe("SSRF guard and sign-up gate (second api with production defaults)", () => {
  // The main instance runs with ALLOW_PRIVATE_CLUSTER_TARGETS=true and
  // SIGNUP_MODE=open so the rest of the suite can use a localhost mongo. This
  // one runs the defaults a hosted deployment gets.
  const PORT = 3098;
  // Server root, not /api: this suite posts to both better-auth (mounted on
  // Fastify at /api/auth, outside Nest's prefix) and to Nest routes (/api/...),
  // so the paths below carry their own prefix.
  const BASE = `http://localhost:${PORT}`;
  let guarded: ChildProcess;
  let guardedOwner: Session;

  const post = async (path: string, session: Session | null, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_ORIGIN,
        ...(session === null ? {} : { cookie: session.cookie }),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    guarded = await startApi(
      {
        ALLOW_PRIVATE_CLUSTER_TARGETS: "false",
        // startApi turns this ON for every instance, because the rest of the
        // suite dials a localhost mongo with no certificate. This instance is
        // the one running hosted defaults, so it has to turn it back off — with
        // it on, the transport guard stands down and a plaintext string reaches
        // the dial instead of being refused.
        ALLOW_INSECURE_CLUSTER_TLS: "false",
        SIGNUP_MODE: "invite",
      },
      PORT,
    );
    // Users already exist (the suite signed some up), so this instance is past
    // its first-user bootstrap: sign-up must now require an invite.
    const email = `blocked-${Date.now()}@int.test`;
    const denied = await post("/api/auth/sign-up/email", null, {
      email,
      password: "password12345",
      name: "Stranger",
    });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).toContain("invite-only");

    // An invited address gets through. Invite from the main instance (shared db).
    const invitee = `invited-${Date.now()}@int.test`;
    const invite = await authPost("/organization/invite-member", owner, {
      email: invitee,
      role: "member",
    });
    expect(invite.status).toBe(200);
    const allowed = await post("/api/auth/sign-up/email", null, {
      email: invitee,
      password: "password12345",
      name: "Invited",
    });
    expect(allowed.status).toBe(200);
    createdEmails.push(email, invitee);
    guardedOwner = sessionFrom(invitee, allowed);
    // The dial guards below are owner-only, and an owner needs somewhere to be
    // the owner OF. Created against this instance, on the shared database.
    createdOrgIds.push(await createOrg(guardedOwner, "Guarded Org", BASE));
  });

  afterAll(async () => {
    await stopApi(guarded);
  });

  // Changing an address must not be the way around SIGNUP_MODE (#83): the
  // same gate that would refuse the sign-up refuses the change, with the same
  // reason, before any verification token exists.
  it("refuses an email change to an address the signup gate would refuse", async () => {
    const refused = await authPost(
      "/change-email",
      guardedOwner,
      { newEmail: `uninvited-${Date.now()}@int.test` },
      BASE,
    );
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain("invite-only");
  });

  it("refuses to dial private addresses, naming the escape hatch", async () => {
    const res = await post("/api/clusters/check-connection", guardedOwner, {
      connectionString: "mongodb://10.0.0.5:27017",
    });
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("private network");
    expect(body).toContain("ALLOW_PRIVATE_CLUSTER_TARGETS");
  });

  // Ordering, not just presence: the address guard runs first, so a private
  // target is refused for being private however its transport is spelled. A
  // PUBLIC plaintext address is where the TLS rule is the one that applies —
  // 8.8.8.8 is an IP literal, so nothing is resolved and nothing is dialled.
  it("refuses a public plaintext address, naming the TLS switch", async () => {
    const res = await post("/api/clusters/check-connection", guardedOwner, {
      connectionString: "mongodb://8.8.8.8:27017",
    });
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("without TLS");
    expect(body).toContain("ALLOW_INSECURE_CLUSTER_TLS");
  });

  // The same address with TLS asked for gets past the string checks and fails
  // for a reason about the cluster instead — proof the rule is about transport
  // and not a blanket refusal.
  it("lets a TLS string through the guards", async () => {
    const res = await post("/api/clusters/check-connection", guardedOwner, {
      connectionString: "mongodb://8.8.8.8:27017/?tls=true&connectTimeoutMS=1500",
    });
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("ALLOW_INSECURE_CLUSTER_TLS");
  });

  it("refuses loopback, so the control plane cannot probe itself", async () => {
    const res = await post("/api/clusters/check-connection", guardedOwner, {
      connectionString: "mongodb://127.0.0.1:27017",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("loopback");
  });

  it("refuses cloud metadata and never stores such a cluster", async () => {
    const res = await post("/api/clusters", guardedOwner, {
      name: "metadata",
      connectionString: "mongodb://169.254.169.254:27017",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("metadata");
    const rows = await db.select().from(clusters).where(eq(clusters.name, "metadata"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a private host smuggled in beside a public one", async () => {
    const res = await post("/api/clusters/check-connection", guardedOwner, {
      connectionString: "mongodb://8.8.8.8:27017,192.168.1.10:27017",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("192.168.1.10");
  });

  it("rate-limits dialing so the guard cannot be brute-forced", async () => {
    // Blocked targets still consume budget — deliberate, so a scanner cannot
    // get free attempts by aiming at addresses the guard rejects. It also
    // keeps this test fast: each call returns immediately instead of waiting
    // out a connection timeout.
    let limited = false;
    let rejections = 0;
    for (let i = 1; i < 20; i++) {
      const res = await post("/api/clusters/check-connection", guardedOwner, {
        connectionString: `mongodb://10.1.0.${i}:27017`,
      });
      if (res.status === 400) rejections += 1;
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    // The budget bites well before 20 attempts.
    expect(rejections).toBeLessThan(15);
  });
});

describe("connection preflight", () => {
  it("reports what a connection string can do without storing anything", async () => {
    const res = await api("/clusters/check-connection", owner, {
      method: "POST",
      body: JSON.stringify({ connectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.reachable).toBe(true);
    // The integration mongod runs without auth: everything is permitted, and
    // the diagnosis says so rather than pretending a scoped user would help.
    expect(body.authEnabled).toBe(false);
    expect(body.ready).toBe(true);
    expect(body.canProvision).toBe(false);
    expect(Array.isArray(body.privileges) && body.privileges.length > 0).toBe(true);

    const before = await db.select().from(clusters);
    expect(before.every((row) => row.name !== "check-connection")).toBe(true);
  });

  it("explains an unreachable target instead of storing a broken cluster", async () => {
    const res = await api("/clusters/check-connection", owner, {
      method: "POST",
      body: JSON.stringify({ connectionString: "mongodb://127.0.0.1:59998" }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.reachable).toBe(false);
    expect(asString(body.message)).toContain("unreachable");

    // And connecting with it fails loudly rather than silently.
    const create = await api("/clusters", owner, {
      method: "POST",
      body: JSON.stringify({ name: "dead", connectionString: "mongodb://127.0.0.1:59998" }),
    });
    expect(create.status).toBe(502);
  });
});

describe("least-privilege provisioning", () => {
  it("creates a scoped user from an admin string and stores only the scoped string", async () => {
    const res = await api("/clusters/provision", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Provisioned Cluster", adminConnectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const clusterRecord = asRecord(body.cluster);
    const provisionedId = asString(clusterRecord.id);
    createdClusterIds.push(provisionedId);
    const username = asString(body.username);
    expect(username).toBe(SCOPED_USERNAME);
    // Returned-once scoped string: our user, forced admin authSource.
    const connectionString = asString(body.connectionString);
    expect(connectionString).toContain(`${username}:`);
    expect(connectionString).toContain("authSource=admin");
    expect(clusterRecord.provisionedUsername).toBe(username);
    expect(clusterRecord.readOnly).toBe(true);

    // The user really exists on the cluster, holding exactly the engine role.
    const info = asRecord(await mongo.db("admin").command({ usersInfo: username }));
    const users = Array.isArray(info.users) ? info.users : [];
    expect(users).toHaveLength(1);
    const roles = asRecord(users[0]).roles;
    expect(Array.isArray(roles) && roles.length === 1).toBe(true);
    expect(asRecord(Array.isArray(roles) ? roles[0] : {}).role).toBe("indexterityEngine");

    // The sealed string the engine dials is the scoped one — collect works on it.
    expect(await collectCluster(db, provisionedId)).toBeGreaterThan(0);

    await mongo.db("admin").command({ dropUser: username });
  });
});

// The safeguard the fixed scoped-user name buys, through the API rather than the
// adapter: the same cluster cannot be added twice under two display names,
// because the second provision asks the server for a user it already has.
//
// Its own account, for the reason the observe-selection block states: both
// provisions DIAL, and spending two of the shared `owner`'s ten shows up as a
// 429 in some later, unrelated test rather than here.
describe("provisioning the same cluster twice", () => {
  let twice: Session;

  beforeAll(async () => {
    twice = await signUp("provtwice");
    createdEmails.push(twice.email);
    createdOrgIds.push(await giveRoom(twice));
  });

  it("refuses the second one with the reason, and leaves the first user alone", async () => {
    const first = await api("/clusters/provision", twice, {
      method: "POST",
      body: JSON.stringify({ name: "Provisioned Once", adminConnectionString: MONGO_URL }),
    });
    expect(first.status).toBe(200);
    const firstBody = asRecord(await first.json());
    const username = asString(firstBody.username);
    try {
      const again = await api("/clusters/provision", twice, {
        method: "POST",
        body: JSON.stringify({ name: "Provisioned Twice", adminConnectionString: MONGO_URL }),
      });
      // 422 with the reason, not a 500: the caller has something to do about it.
      expect(again.status).toBe(422);
      expect(asString(asRecord(await again.json()).message)).toMatch(/already has an Indexterity/i);

      // And the refusal did not take the working user down with it — rolling
      // back a provision that never happened would revoke the credentials the
      // first cluster is running on.
      const info = asRecord(await mongo.db("admin").command({ usersInfo: username }));
      expect(Array.isArray(info.users) && info.users.length === 1).toBe(true);
    } finally {
      await mongo
        .db("admin")
        .command({ dropUser: username })
        .catch(() => {});
    }
  });
});

describe("cluster offboarding", () => {
  it("offboards a provisioned cluster and returns the revoke command", async () => {
    const res = await api("/clusters/provision", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Offboard Provisioned", adminConnectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const username = asString(body.username);
    const id = asString(asRecord(body.cluster).id);

    const del = await api(`/clusters/${id}`, owner, { method: "DELETE" });
    expect(del.status).toBe(200);
    const deleted = asRecord(await del.json());
    expect(deleted.unhidden).toBe(0);
    expect(deleted.revokeCommand).toBe(`db.getSiblingDB("admin").dropUser("${username}")`);

    // Run the revoke and confirm the scoped user is gone.
    await mongo.db("admin").command({ dropUser: username });
    const info = asRecord(await mongo.db("admin").command({ usersInfo: username }));
    expect(Array.isArray(info.users) && info.users.length === 0).toBe(true);
  });

  it("restores hidden indexes and cascades all data on delete", async () => {
    const res = await api("/clusters", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Offboard Plain", connectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    const id = asString(asRecord(await res.json()).id);
    await mongo
      .db("inttest")
      .collection("orders")
      .createIndex({ tmpHide: 1 }, { name: "tmp_hide_1" });
    await mongo
      .db("inttest")
      .command({ collMod: "orders", index: { name: "tmp_hide_1", hidden: true } });
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId: id,
        type: "DROP_UNUSED",
        state: "HIDDEN",
        database: "inttest",
        collection: "orders",
        indexName: "tmp_hide_1",
        rationale: "offboard restore",
        estimatedBytesSaved: 0,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    const del = await api(`/clusters/${id}`, owner, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(asRecord(await del.json()).unhidden).toBe(1);

    // The in-flight hidden index was restored on the customer cluster...
    const specs = await mongo.db("inttest").collection("orders").indexes();
    const restored = specs.find((spec) => spec.name === "tmp_hide_1");
    expect(restored !== undefined && restored.hidden !== true).toBe(true);
    await mongo.db("inttest").collection("orders").dropIndex("tmp_hide_1");

    // ...and every stored row cascaded away.
    const policyRes = await api(`/clusters/${id}/policy`, owner);
    expect(policyRes.status).toBe(404);
    const remaining = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, id));
    expect(remaining).toHaveLength(0);
  });
});

// The rules the api used to implement twice, in two places, with two different
// error messages. They are the plugin's now — which is the point of the change,
// and exactly why they are still tested here rather than taken on trust.
describe("org management", () => {
  it("renames the org (owner only)", async () => {
    const denied = await authPost("/organization/update", member, {
      data: { name: "Nope Corp" },
    });
    expect(denied.status).toBe(403);
    const renamed = await authPost("/organization/update", owner, {
      data: { name: "Renamed Intcorp" },
    });
    expect(renamed.status).toBe(200);
    const org = asRecord(await (await api("/org", owner)).json());
    expect(org.name).toBe("Renamed Intcorp");
  });

  // The plan lives on the org, and only set-plan.ts (or, one day, a webhook) may
  // write it. `input: false` on the additional fields is what keeps an owner
  // from posting themselves onto SCALE through the endpoint that renames it.
  it("will not let an owner set their own plan through the plugin", async () => {
    const upgrader = await signUp("upgrader");
    createdEmails.push(upgrader.email);
    const orgId = asString(asRecord(await (await api("/org", upgrader)).json()).id);
    createdOrgIds.push(orgId);

    // Whatever the deployment's DEFAULT_ORG_PLAN put here, rather than a
    // literal. Pinning FREE would pass for the wrong reason on an api booted
    // without the variable — which is the whole of #132 — and fail on one
    // booted with it.
    const [before] = await db
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(before?.plan).not.toBeUndefined();

    const res = await authPost("/organization/update", upgrader, {
      data: { name: "Still Free", plan: "SCALE" },
    });
    // Accepted as a rename; `plan` is simply not in the body schema.
    expect(res.status).toBe(200);
    const [org] = await db
      .select({ plan: organizations.plan, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(org?.name).toBe("Still Free");
    expect(org?.plan).toBe(before?.plan);
  });

  it("guards the last owner and round-trips a role change", async () => {
    const ownerOrg = asRecord(await (await api("/org", owner)).json());
    // Target by email — switcher is also a plain member of this org.
    const rows = Array.isArray(ownerOrg.members) ? ownerOrg.members.map(asRecord) : [];
    const ownerRow = rows.find((entry) => entry.email === owner.email);
    const memberRow = rows.find((entry) => entry.email === member.email);
    if (ownerRow === undefined || memberRow === undefined) throw new Error("rows missing");

    // Demoting the sole owner is refused — by the plugin, once, instead of by
    // two hand-written guards with two different messages.
    const selfDemote = await authPost("/organization/update-member-role", owner, {
      memberId: asString(ownerRow.memberId),
      role: "member",
    });
    expect(selfDemote.status).toBe(400);

    // A role we do not have is refused too: owner and member, and no third rung
    // half the api would not understand.
    const admin = await authPost("/organization/update-member-role", owner, {
      memberId: asString(memberRow.memberId),
      role: "admin",
    });
    expect(admin.status).toBe(400);

    // Promote, then demote back.
    const promote = await authPost("/organization/update-member-role", owner, {
      memberId: asString(memberRow.memberId),
      role: "owner",
    });
    expect(promote.status).toBe(200);
    const demote = await authPost("/organization/update-member-role", owner, {
      memberId: asString(memberRow.memberId),
      role: "member",
    });
    expect(demote.status).toBe(200);
  });

  it("removes a member, who is then in no org of this one's", async () => {
    const ownerOrg = asRecord(await (await api("/org", owner)).json());
    const memberRow = (Array.isArray(ownerOrg.members) ? ownerOrg.members.map(asRecord) : []).find(
      (entry) => entry.email === member.email,
    );
    if (memberRow === undefined) throw new Error("member row missing");
    const removed = await authPost("/organization/remove-member", owner, {
      memberIdOrEmail: asString(memberRow.memberId),
    });
    expect(removed.status).toBe(200);
    const after = asRecord(await (await api("/org", owner)).json());
    const emails = (Array.isArray(after.members) ? after.members.map(asRecord) : []).map(
      (entry) => entry.email,
    );
    expect(emails).not.toContain(member.email);

    // They fall back to the org they made at sign-up rather than to a shell the
    // api invented for them...
    const own = asRecord(await (await api("/org", member)).json());
    expect(own.name).toBe("member Org");
    expect(Array.isArray(own.members) && own.members.length === 1).toBe(true);
    // ...where they are the sole owner, so leaving is refused.
    const leave = await authPost("/organization/leave", member, {
      organizationId: asString(own.id),
    });
    expect(leave.status).toBe(400);
  });

  it("lets a non-last-owner leave, falling back to their own org", async () => {
    // switcher is a plain member of the owner's org (from the switch test), so
    // leaving works and rescopes them to their own.
    const leave = await authPost("/organization/leave", switcher, {
      organizationId: ownerOrgId,
    });
    expect(leave.status).toBe(200);
    const clustersAfter = await (await api("/clusters", switcher)).json();
    const names = Array.isArray(clustersAfter)
      ? clustersAfter.map((entry) => asRecord(entry).name)
      : [];
    expect(names).toContain("Switcher Own");
    expect(names).not.toContain("Int Cluster");
  });
});

describe("change window gates elective builds", () => {
  const setWindow = async (start: number | null, end: number | null) => {
    const res = await api(`/clusters/${clusterId}/policy`, owner, {
      method: "PUT",
      body: JSON.stringify({
        workloadAnalysis: true,
        instantCreate: false,
        observeWindowDays: 7,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: start,
        changeWindowEndHour: end,
      }),
    });
    expect(res.status).toBe(200);
  };

  it("holds an approved CREATE outside the window, builds inside it", async () => {
    // The job code runs IN THIS PROCESS here — it needs the same MASTER_KEY the
    // api child was started with to unseal the cluster's connection string.
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "CREATE",
        state: "APPROVED",
        database: "inttest",
        collection: "orders",
        indexName: "winidx_1",
        rationale: "change-window test",
        estimatedBytesSaved: 0,
        targetSpec: { keys: ["winidx"], retire: [] },
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    // A window that excludes the current hour: nothing may build.
    const hour = new Date().getUTCHours();
    await setWindow((hour + 2) % 24, (hour + 3) % 24);
    expect(await applyCreatesForCluster(db, clusterId)).toBe(0);
    const [held] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(held?.state).toBe("APPROVED");

    // Clearing the window lets the same tick build it.
    await setWindow(null, null);
    expect(await applyCreatesForCluster(db, clusterId)).toBe(1);
    const specs = await mongo.db("inttest").collection("orders").indexes();
    expect(specs.some((spec) => spec.name === "winidx_1")).toBe(true);
    await mongo.db("inttest").collection("orders").dropIndex("winidx_1");
  });

  // The claim the whole re-order feature rests on, made against a real mongod
  // rather than argued: a unique index's guarantee is a property of its key SET,
  // not of its key directions, so swapping the directions preserves it — and
  // building the replacement BEFORE retiring the original means there is no
  // instant when nothing is enforcing it.
  //
  // Asserted at all three moments, because only the last one is the interesting
  // claim and only the first two make it safe: before the swap, while both
  // exist, and after the original is gone.
  it("re-orders a unique index's keys without ever losing the constraint", async () => {
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    await setWindow(null, null);
    const coll = mongo.db("inttest").collection("reorder");
    await coll.deleteMany({});
    await coll.insertMany([
      { a: 1, b: 1 },
      { a: 1, b: 2 },
    ]);
    await coll.createIndex({ a: 1, b: 1 }, { name: "a_1_b_1", unique: true });

    const duplicateRefused = async (): Promise<boolean> => {
      try {
        await coll.insertOne({ a: 1, b: 1 });
        await coll.deleteOne({ a: 1, b: 1, _id: { $exists: true } });
        return false;
      } catch {
        return true;
      }
    };
    expect(await duplicateRefused()).toBe(true);

    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "REORDER",
        state: "APPROVED",
        database: "inttest",
        collection: "reorder",
        indexName: "a_1_b_-1",
        rationale: "reorder integration test",
        estimatedBytesSaved: 0,
        targetSpec: {
          keys: ["a", "b:-1"],
          retire: ["a_1_b_1"],
          options: { unique: true, sparse: false, collation: null },
        },
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    // Build first. The options travel with the row, so the replacement arrives
    // unique — an index rebuilt without it would be the constraint removed.
    expect(await applyCreatesForCluster(db, clusterId)).toBe(1);
    const built = await coll.indexes();
    const replacement = built.find((spec) => spec.name === "a_1_b_-1");
    expect(replacement?.unique).toBe(true);
    expect(replacement?.key).toEqual({ a: 1, b: -1 });
    // Both present, and the rule still holds.
    expect(await duplicateRefused()).toBe(true);

    // Graduate the build: the watch has elapsed and writes are stable, so
    // finalize proposes retiring the original — naming what replaced it, which
    // is the only thing that lets a protected index be dropped at all.
    await db
      .update(recommendations)
      .set({ builtAt: new Date(Date.now() - 60 * 86_400_000) })
      .where(eq(recommendations.id, rec.id));
    await finalizeCluster(db, clusterId);
    const [retirement] = await db
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.indexName, "a_1_b_1"),
          eq(recommendations.state, "PROPOSED"),
        ),
      );
    expect(retirement?.type).toBe("DROP_REDUNDANT");
    expect(retirement?.targetSpec?.supersededBy).toBe("a_1_b_-1");
    expect(retirement?.rationale).toContain("unique constraint");

    // And the drop itself, through the ordinary gates. Hidden first, observed,
    // then dropped — a protected index gets no shortcut for being replaceable.
    await db
      .update(recommendations)
      .set({ state: "HIDDEN", hiddenAt: new Date(Date.now() - 60 * 86_400_000), observeDays: 1 })
      .where(eq(recommendations.id, retirement?.id ?? ""));
    await mongo
      .db("inttest")
      .command({ collMod: "reorder", index: { name: "a_1_b_1", hidden: true } });
    await finalizeCluster(db, clusterId);

    const after = await coll.indexes();
    expect(after.some((spec) => spec.name === "a_1_b_1")).toBe(false);
    expect(after.some((spec) => spec.name === "a_1_b_-1")).toBe(true);
    // The point of all of it: with the original gone, the survivor still
    // refuses the duplicate.
    expect(await duplicateRefused()).toBe(true);

    await coll.drop();
  });
});

describe("dynamic observe window", () => {
  it("extends the window at hide time when usage history is periodic", async () => {
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    await mongo.db("inttest").collection("orders").createIndex({ dyn: 1 }, { name: "dyn_1" });
    // Usage on day 0, 20, 40 (gaps of 20 days): the policy window here is 7
    // days, which would expire between two runs — expect 2×20 = 40 days.
    const base = Date.now() - 45 * 86_400_000;
    await insertSnapshots(
      db,
      [0, 10, 20, 30, 40].map((day) => ({
        clusterId,
        database: "inttest",
        collection: "orders",
        indexName: "dyn_1",
        spec: { name: "dyn_1" },
        sizeBytes: 4096,
        perMember: [{ member: "m1", ops: day % 20 === 0 ? 5 : 0 }],
        capturedAt: new Date(base + day * 86_400_000),
      })),
    );
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "APPROVED",
        database: "inttest",
        collection: "orders",
        indexName: "dyn_1",
        rationale: "dynamic observe test",
        estimatedBytesSaved: 0,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    expect(await applyCluster(db, clusterId)).toBe(1);
    const [hidden] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(hidden?.state).toBe("HIDDEN");
    expect(hidden?.observeDays).toBe(40);

    // Restore the cluster: un-hide and drop the test index.
    await mongo
      .db("inttest")
      .command({ collMod: "orders", index: { name: "dyn_1", hidden: false } });
    await mongo.db("inttest").collection("orders").dropIndex("dyn_1");
  });
});

// A cluster row with no usable connection string, for scenarios that only touch
// postgres. Going through POST /clusters would seal a real string and spend a
// unit of the outbound-dial budget, which is a shared resource across the suite.
async function bareCluster(name: string): Promise<string> {
  const org = asRecord(await (await api("/org", owner)).json());
  const [row] = await db
    .insert(clusters)
    .values({
      orgId: asString(org.id),
      name,
      sealedDek: Buffer.alloc(1),
      sealedData: Buffer.alloc(1),
      keyVersion: 1,
    })
    .returning();
  if (row === undefined) throw new Error(`failed to insert cluster ${name}`);
  createdClusterIds.push(row.id);
  return row.id;
}

describe("outage resilience", () => {
  it("keeps observing across a restart, and gives up only past the wall-clock cap", async () => {
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    await mongo.db("inttest").collection("orders").createIndex({ outage: 1 }, { name: "outage_1" });
    await mongo
      .db("inttest")
      .command({ collMod: "orders", index: { name: "outage_1", hidden: true } });

    // Hidden four days ago with a two-day window, and a baseline FAR above the
    // live counters — what a mongod restart during the window leaves behind.
    // The old gate read that as "the observation never happened", un-hid the
    // index and re-proposed it; on a cluster that restarts nightly it did so
    // every time, forever. Now the restart costs the stretch it landed in and
    // the rest of the observation stands.
    const hiddenAt = new Date(Date.now() - 4 * 86_400_000);
    const insert = async (name: string, at: Date) =>
      (
        await db
          .insert(recommendations)
          .values({
            clusterId,
            type: "DROP_UNUSED",
            state: "HIDDEN",
            database: "inttest",
            collection: name,
            indexName: "outage_1",
            rationale: "outage test",
            estimatedBytesSaved: 0,
            hiddenAt: at,
            observeDays: 2,
            baselineReadOps: 5_000_000,
            baselineReadLatency: 5_000_000_000,
          })
          .returning()
      )[0];

    // Hourly readings across the window, with the counters restarting a day in.
    // Latency per op is steady at 1000µs, well under the recorded baseline's
    // 1000µs — so nothing regressed and the drop is owed.
    const samples = [];
    let ops = 4_000;
    let micros = 4_000 * 1_000;
    for (let hour = 0; hour < 96; hour++) {
      if (hour === 24) {
        ops = 0;
        micros = 0;
      }
      const at = new Date(hiddenAt.getTime() + hour * 3_600_000);
      samples.push({
        clusterId,
        database: "inttest",
        collection: "orders",
        readOps: ops,
        readLatencyMicros: micros,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: at,
        lastSeenAt: at,
      });
      ops += 500;
      micros += 500 * 1_000;
    }
    await insertLatency(db, samples);

    const rec = await insert("orders", hiddenAt);
    if (rec === undefined) throw new Error("failed to insert recommendation");
    await finalizeCluster(db, clusterId);

    const [after] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    // The restart cost one hour of observation out of 95, so the two-day window
    // filled and the drop went through — where before it was un-hidden.
    expect(after?.state).toBe("DROPPED");
    const specs = await mongo.db("inttest").collection("orders").indexes();
    expect(specs.some((spec) => spec.name === "outage_1")).toBe(false);
  });

  it("graduates a build across restarts, and files the retirement that depends on it", async () => {
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    // The post-build write watch used to reset `built_at` to now whenever the
    // counters fell, so on a cluster restarting oftener than the window it never
    // reached the end — and graduation is the ONLY thing that files the
    // retirement of what the build superseded (#394). Nothing was executed
    // wrongly; a correct finding was simply never made.
    // The suite does not reset the database between runs, and both tables reject
    // a second copy of this fixture — latency_samples on its no-overlap
    // exclusion, recommendations on the one-live-claim index.
    await db
      .delete(latencySamples)
      .where(
        and(eq(latencySamples.clusterId, clusterId), eq(latencySamples.collection, "graduates")),
      );
    await db
      .delete(recommendations)
      .where(
        and(eq(recommendations.clusterId, clusterId), eq(recommendations.collection, "graduates")),
      );
    // Long enough to clear the policy's observe window whichever it is here —
    // the write watch reads the cluster policy, not the row's own `observeDays`.
    const builtAt = new Date(Date.now() - 32 * 86_400_000);
    const samples = [];
    let ops = 4_000;
    let micros = 4_000 * 1_000;
    for (let hour = 0; hour < 32 * 24; hour++) {
      // Restarted a day into the watch: the whole reason the old gate gave up.
      if (hour === 24) {
        ops = 0;
        micros = 0;
      }
      const at = new Date(builtAt.getTime() + hour * 3_600_000);
      samples.push({
        clusterId,
        database: "inttest",
        collection: "graduates",
        readOps: 0,
        readLatencyMicros: 0,
        writeOps: ops,
        writeLatencyMicros: micros,
        capturedAt: at,
        lastSeenAt: at,
      });
      ops += 500;
      micros += 500 * 1_000;
    }
    await insertLatency(db, samples);

    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "UPDATE",
        state: "ACTIVE",
        source: "WORKLOAD",
        database: "inttest",
        collection: "graduates",
        indexName: "a_1_b_1",
        rationale: "extend a_1 to {a, b}",
        score: 70,
        builtAt,
        baselineWriteOps: 4_000,
        baselineWriteLatency: 4_000 * 1_000,
        targetSpec: { keys: ["a", "b"], retire: ["a_1"] },
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    await finalizeCluster(db, clusterId);

    // Graduated: baselines cleared, so it also leaves the `watched` guard that
    // was suppressing every later finding on this index.
    const [after] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(after?.baselineWriteOps).toBeNull();
    // ...and the retirement the graduation exists to file.
    const [retirement] = await db
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.collection, "graduates"),
          eq(recommendations.indexName, "a_1"),
        ),
      );
    expect(retirement?.type).toBe("DROP_REDUNDANT");
    expect(retirement?.state).toBe("PROPOSED");
  });

  it("un-hides an index whose window cannot fill, rather than leaving it hidden", async () => {
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    // Its own collection, so the un-hide below has a real namespace to reach and
    // no latency history exists for it — which is the state under test.
    await mongo.db("inttest").collection("blindcoll").insertOne({ blind: 1 });
    await mongo
      .db("inttest")
      .collection("blindcoll")
      .createIndex({ blind: 1 }, { name: "blind_1" });
    await mongo
      .db("inttest")
      .command({ collMod: "blindcoll", index: { name: "blind_1", hidden: true } });

    // Hidden for well past the cap with no readings at all to show for it. The
    // observation cannot complete, so the index goes back rather than sitting
    // hidden indefinitely waiting for evidence that is not coming.
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "HIDDEN",
        database: "inttest",
        collection: "blindcoll",
        indexName: "blind_1",
        rationale: "blind test",
        estimatedBytesSaved: 0,
        hiddenAt: new Date(Date.now() - 30 * 86_400_000),
        observeDays: 2,
        baselineReadOps: 5_000_000,
        baselineReadLatency: 5_000_000_000,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    await finalizeCluster(db, clusterId);

    const [after] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(after?.state).toBe("PROPOSED");
    expect(after?.hiddenAt).toBeNull();
    const trail = await db.select().from(actions).where(eq(actions.recommendationId, rec.id));
    expect(trail.some((entry) => entry.result.includes("could be measured"))).toBe(true);
    // Really put back, not just marked so.
    const specs = await mongo.db("inttest").collection("blindcoll").indexes();
    const restored = specs.find((spec) => spec.name === "blind_1");
    expect(restored !== undefined && restored.hidden !== true).toBe(true);

    await mongo.db("inttest").collection("blindcoll").drop();
  });

  // The Definition of Done of the change that made storage independent of the
  // collect cadence. An idle index and a cluster we lost both stop producing new
  // rows, and the engine has to keep telling them apart: the first is the finding
  // it exists to make, the second the one it must refuse. What separates them is
  // that a run is a positive claim — we looked at last_seen_at and it was still
  // this — where an outage has nothing to say.
  it("drops an idle index whose run is still being extended", async () => {
    // Inserted rather than connected: classifyCluster reads only postgres, and
    // dialing would spend the outbound-dial budget the later scenarios need.
    const idleId = await bareCluster("Idle Run Cluster");

    const now = Date.now();
    const monthAgo = now - 30 * 86_400_000;
    const spec = {
      name: "idle_run_1",
      keys: [{ field: "idle", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    // ONE row for thirty days of collects, because the counter never moved —
    // which is the whole storage saving, expressed as a fixture.
    await insertSnapshots(db, [
      {
        clusterId: idleId,
        database: "inttest",
        collection: "idlerun",
        indexName: "idle_run_1",
        spec,
        sizeBytes: 8192,
        perMember: [{ member: "m1", ops: 0, since: new Date(monthAgo - 86_400_000).toISOString() }],
        capturedAt: new Date(monthAgo),
        lastSeenAt: new Date(now),
        observations: 120,
      },
    ]);
    // The collection itself was busy, or the activity gate is right to refuse.
    await insertLatency(
      db,
      Array.from({ length: 120 }, (_, i) => ({
        clusterId: idleId,
        database: "inttest",
        collection: "idlerun",
        readOps: (i + 1) * 1000,
        readLatencyMicros: (i + 1) * 100,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date(monthAgo + i * 6 * 3_600_000),
      })),
    );

    expect(await classifyCluster(db, idleId)).toBe(1);
    const [proposal] = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, idleId));
    expect(proposal?.type).toBe("DROP_UNUSED");
    expect(proposal?.usageClass).toBe("FLAT_ZERO");
    // And the score reflects a hundred and twenty collects of evidence, not the
    // one row holding them.
    expect(proposal?.score ?? 0).toBeGreaterThan(70);
  });

  it("refuses the same index when its run stopped being extended", async () => {
    const lostId = await bareCluster("Lost Run Cluster");

    const now = Date.now();
    const monthAgo = now - 30 * 86_400_000;
    // Byte-identical to the fixture above in every respect except one: nothing
    // has confirmed it for three weeks, because that is when the cluster went
    // away. Same row count, same observation count, same counters.
    await insertSnapshots(db, [
      {
        clusterId: lostId,
        database: "inttest",
        collection: "idlerun",
        indexName: "idle_run_1",
        spec: {
          name: "idle_run_1",
          keys: [{ field: "idle", direction: 1 }],
          unique: false,
          ttl: false,
          partial: false,
          partialFilter: null,
          sparse: false,
          hidden: false,
          isShardKey: false,
          collation: null,
        },
        sizeBytes: 8192,
        perMember: [{ member: "m1", ops: 0, since: new Date(monthAgo - 86_400_000).toISOString() }],
        capturedAt: new Date(monthAgo),
        lastSeenAt: new Date(now - 21 * 86_400_000),
        observations: 120,
      },
    ]);
    await insertLatency(
      db,
      Array.from({ length: 120 }, (_, i) => ({
        clusterId: lostId,
        database: "inttest",
        collection: "idlerun",
        readOps: (i + 1) * 1000,
        readLatencyMicros: (i + 1) * 100,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date(monthAgo + i * 6 * 3_600_000),
      })),
    );

    expect(await classifyCluster(db, lostId)).toBe(0);
    expect(
      await db.select().from(recommendations).where(eq(recommendations.clusterId, lostId)),
    ).toHaveLength(0);
  });

  it("withholds usage-based drops when the snapshot history has a hole", async () => {
    // A cluster whose only history predates a long gap must not have its
    // indexes declared unused. Fresh cluster, snapshots aged a month.
    const res = await api("/clusters", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Gapped Cluster", connectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    const gappedId = asString(asRecord(await res.json()).id);
    createdClusterIds.push(gappedId);

    const old = Date.now() - 30 * 86_400_000;
    await insertSnapshots(
      db,
      [0, 1, 2].map((day) => ({
        clusterId: gappedId,
        database: "inttest",
        collection: "orders",
        indexName: "gap_probe_1",
        spec: {
          name: "gap_probe_1",
          keys: [{ field: "gap", direction: 1 }],
          unique: false,
          ttl: false,
          partial: false,
          partialFilter: null,
          sparse: false,
          hidden: false,
          isShardKey: false,
          collation: null,
        },
        sizeBytes: 8192,
        perMember: [{ member: "m1", ops: 0 }],
        capturedAt: new Date(old + day * 86_400_000),
      })),
    );

    expect(await classifyCluster(db, gappedId)).toBe(0);
    const proposals = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, gappedId));
    expect(proposals).toHaveLength(0);
  });

  it("withholds a drop when a member's $indexStats counter restarted", async () => {
    // Inserted directly: classify reads only Postgres, and the api's per-user
    // dial budget is (correctly) spent by this point in the suite.
    const org = asRecord(await (await api("/org", owner)).json());
    const [row] = await db
      .insert(clusters)
      .values({
        orgId: asString(org.id),
        name: "Restart Cluster",
        sealedDek: Buffer.alloc(1),
        sealedData: Buffer.alloc(1),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("failed to insert cluster");
    const restartId = row.id;
    createdClusterIds.push(restartId);

    const base = Date.now() - 3 * 86_400_000;
    const spec = {
      name: "restart_probe_1",
      keys: [{ field: "probe", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    // A busy index whose member restarts just before the last snapshot: ops
    // read zero afterwards, which without `since` is indistinguishable from
    // an index nobody uses.
    const counterStart = new Date(base).toISOString();
    const afterRestart = new Date(base + 2.5 * 86_400_000).toISOString();
    await insertSnapshots(db, [
      {
        clusterId: restartId,
        database: "inttest",
        collection: "orders",
        indexName: "restart_probe_1",
        spec,
        sizeBytes: 4096,
        perMember: [{ member: "m1", ops: 0, since: counterStart }],
        capturedAt: new Date(base),
      },
      {
        clusterId: restartId,
        database: "inttest",
        collection: "orders",
        indexName: "restart_probe_1",
        spec,
        sizeBytes: 4096,
        perMember: [{ member: "m1", ops: 0, since: counterStart }],
        capturedAt: new Date(base + 86_400_000),
      },
      {
        clusterId: restartId,
        database: "inttest",
        collection: "orders",
        indexName: "restart_probe_1",
        spec,
        sizeBytes: 4096,
        perMember: [{ member: "m1", ops: 0, since: afterRestart }],
        capturedAt: new Date(),
      },
    ]);

    expect(await classifyCluster(db, restartId)).toBe(0);
    const proposals = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, restartId));
    expect(proposals).toHaveLength(0);

    // ...and the empty list now says why (#277). The reason is the WARM-UP, not
    // the restart: the restart ends the first epoch after a day of watching and
    // opens a second that is one snapshot long, so a seven-day gate has a day of
    // trustworthy history to weigh and refuses on that. Which is the difference
    // the epoch model bought — a day that counts and grows, where a reset used to
    // void the history and keep voiding it for as long as the restarts lasted.
    //
    // A day is short of the warm-up whether that is three days or seven (#434), so
    // this case is unmoved by the split; what changed is which number the sentence
    // quotes.
    const [note] = await db
      .select()
      .from(analysisNotes)
      .where(eq(analysisNotes.clusterId, restartId));
    expect(note?.consideredIndexes).toBe(1);
    expect(note?.trustedIndexes).toBe(0);
    expect(note?.refusals).toEqual({ "span-too-short": 1 });

    // Through the endpoint the dashboard actually reads, with the sentence built
    // from the thresholds the gate used rather than stored beside them.
    const payload = asRecord(
      await (await api(`/clusters/${restartId}/recommendations`, owner)).json(),
    );
    const analysis = asRecord(payload.analysis);
    expect(analysis.usagePaused).toBe(true);
    expect(analysis.dominantRefusal).toBe("span-too-short");
    expect(analysis.refusedIndexes).toBe(1);
    expect(String(analysis.explanation)).toContain("less than 3 days");
    expect(String(analysis.explanation)).toContain("A restart does not reset that clock");
    expect(String(analysis.explanation)).toContain("Redundancy findings are unaffected.");
  });

  it("persists the real counter-start time from a live collect", async () => {
    // Snapshots written by the collector (other tests hand-seed rows, so look
    // at what a real collect produced for the main cluster's own indexes).
    const rows = await db
      .select()
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, clusterId));
    const collected = rows.filter((row) => row.perMember.some((m) => m.since !== undefined));
    expect(collected.length).toBeGreaterThan(0);
    // The value comes from $indexStats.accesses.since — not synthesized from
    // the snapshot's own timestamp, which is what the code used to do.
    const genuine = collected.some((row) =>
      row.perMember.some(
        (member) =>
          typeof member.since === "string" && member.since !== row.capturedAt.toISOString(),
      ),
    );
    expect(genuine).toBe(true);
  });

  it("reports collection freshness so stale numbers cannot look current", async () => {
    const list = await (await api("/clusters", owner)).json();
    const rows = Array.isArray(list) ? list.map(asRecord) : [];
    const gapped = rows.find((row) => row.name === "Gapped Cluster");
    expect(typeof gapped?.lastCollectedAt).toBe("string");
    // A month-old newest snapshot — the dashboard badges this.
    const age = Date.now() - new Date(asString(gapped?.lastCollectedAt)).getTime();
    expect(age).toBeGreaterThan(20 * 86_400_000);
  });
});

describe("password reset (changes the owner password — keep near the end)", () => {
  it("round-trips request -> stored token -> new password -> sign-in", async () => {
    const res = await fetch(`${API_BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: owner.email, redirectTo: `${WEB_ORIGIN}/reset-password` }),
    });
    expect(res.status).toBe(200);

    // The mailer is a no-op without SMTP; fish the token better-auth stored
    // out of the verification table instead of an inbox.
    const [ownerUser] = await db.select().from(user).where(eq(user.email, owner.email));
    if (ownerUser === undefined) throw new Error("owner user missing");
    const rows = await db.select().from(verification).where(eq(verification.value, ownerUser.id));
    const reset = rows.find((row) => row.identifier.startsWith("reset-password:"));
    if (reset === undefined) throw new Error("reset token was not stored");
    const token = reset.identifier.slice("reset-password:".length);

    // The session the account was already holding, captured BEFORE the reset.
    // Copied rather than aliased: `owner.cookie` moves forward as scenarios
    // adopt cookies, and this has to be the old value.
    const sessionBeforeReset: Session = { email: owner.email, cookie: owner.cookie };
    const tokensBeforeReset = await db
      .select({ token: session.token })
      .from(session)
      .where(eq(session.userId, ownerUser.id));
    expect(tokensBeforeReset.length).toBeGreaterThan(0);

    const apply = await fetch(`${API_BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ token, newPassword: "rotated-pass-456" }),
    });
    expect(apply.status).toBe(200);

    const signInRes = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: owner.email, password: "rotated-pass-456" }),
    });
    expect(signInRes.status).toBe(200);

    // revokeSessionsOnPasswordReset (auth.config.ts): every session the account
    // held before the reset is gone from the database.
    //
    // Asserted as "none of those tokens is left" rather than as a count of what
    // is: better-auth mints a session on the reset itself, so the account
    // legitimately holds more than the one the sign-in above just made, and a
    // count would be an assertion about that incidental behaviour instead of
    // about the revocation. Checked on the rows because the cookie cache
    // answers for up to its maxAge on a client that still holds one, which
    // makes the request below the weaker half of this.
    const tokensAfterReset = await db
      .select({ token: session.token })
      .from(session)
      .where(eq(session.userId, ownerUser.id));
    const survivors = tokensAfterReset
      .map((row) => row.token)
      .filter((token) => tokensBeforeReset.some((old) => old.token === token));
    expect(survivors).toEqual([]);

    // And the old session TOKEN no longer authorises anything. The cached copy
    // is dropped from the jar first, on purpose: the cache is a signed snapshot
    // with its own maxAge and would answer this request without consulting the
    // row, so leaving it in would test the cache rather than the revocation —
    // and would pass equally well with the option off.
    const tokenOnly: Session = {
      email: owner.email,
      cookie: sessionBeforeReset.cookie
        .split("; ")
        .filter((pair) => pair.includes("session_token"))
        .join("; "),
    };
    expect(tokenOnly.cookie).not.toBe("");
    const afterReset = await api("/clusters", tokenOnly);
    expect(afterReset.status).toBe(401);
  });
});

describe("cancelling a pending drop", () => {
  it("un-hides the index on request and parks it without counting a regression", async () => {
    const coll = mongo.db("inttest").collection("keepme");
    await coll.insertMany(Array.from({ length: 20 }, (_, i) => ({ k: i })));
    await coll.createIndex({ k: 1 }, { name: "keep_1" });

    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "HIDDEN",
        database: "inttest",
        collection: "keepme",
        indexName: "keep_1",
        rationale: "no recorded usage",
        score: 72,
        estimatedBytesSaved: 4096,
        hiddenAt: new Date(),
        observeDays: 30,
        baselineReadOps: 10,
        baselineReadLatency: 100,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");
    await coll.dropIndex("keep_1").catch(() => {});
    await coll.createIndex({ k: 1 }, { name: "keep_1" });
    await mongo
      .db("inttest")
      .command({ collMod: "keepme", index: { name: "keep_1", hidden: true } });

    const res = await api(`/recommendations/${rec.id}/unhide`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(asRecord(await res.json()).state).toBe("REJECTED");

    // Visible to the planner again.
    const specs = await coll.indexes();
    expect(specs.find((s) => s.name === "keep_1")?.hidden).toBeFalsy();

    // Parked, but not recorded as a regression — that number feeds the score
    // and the escalating backoff, and nothing regressed here.
    const [cooldown] = await db
      .select()
      .from(indexCooldowns)
      .where(and(eq(indexCooldowns.clusterId, clusterId), eq(indexCooldowns.indexName, "keep_1")));
    expect(cooldown?.regressionCount).toBe(0);
    expect((cooldown?.until.getTime() ?? 0) > Date.now()).toBe(true);

    // And a reader can now see it (#159). The row above was written by exactly
    // one function and read by no controller until this route existed.
    //
    // Asserted per row rather than on the total: earlier scenarios in this file
    // park indexes on the same cluster, so a fixed count here would be a claim
    // about the order of the whole suite. The two totals are checked as
    // invariants against the list instead, which is what they have to be.
    const parked = asRecord(await (await api(`/clusters/${clusterId}/cooldowns`, owner)).json());
    const entries = asRecords(parked.parked, "parked.parked");
    const kept = entries.find((entry) => entry.indexName === "keep_1");
    expect(kept?.reason).toBe("drop cancelled by an owner");
    expect(kept?.regressionCount).toBe(0);
    expect(kept?.active).toBe(true);
    expect(kept?.until).toBe(cooldown?.until.toISOString());

    const stillParked = entries.filter((entry) => entry.active);
    expect(parked.activeCount).toBe(stillParked.length);
    // The SOONEST one still in force, which is what "next eligible" means.
    expect(parked.nextEligibleAt).toBe(stillParked.map((entry) => entry.until).sort()[0] ?? null);
    // Newest expiry first, so the panel reads top-down from the longest park.
    expect([...entries].sort((a, b) => String(b.until).localeCompare(String(a.until)))).toEqual(
      entries,
    );

    // Another tenant sees an empty set, not a refusal — the same shape as a
    // cluster that has never parked anything.
    const stranger = await signUp("cooldowns-stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const foreign = asRecord(
      await (await api(`/clusters/${clusterId}/cooldowns`, stranger)).json(),
    );
    expect(foreign.activeCount).toBe(0);
    expect(foreign.nextEligibleAt).toBeNull();
    expect(foreign.parked).toEqual([]);

    // Second call is a conflict — it is no longer hidden.
    const again = await api(`/recommendations/${rec.id}/unhide`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);

    // A cooldown OUTLIVES the recommendation that caused it, which is why this
    // route reads the table on its own: deleting the row that was cancelled must
    // not take the park with it. Retention and the next classify pass both do
    // exactly this, and a join would lose the longest-standing entries.
    await db.delete(recommendations).where(eq(recommendations.id, rec.id));
    const orphaned = asRecord(await (await api(`/clusters/${clusterId}/cooldowns`, owner)).json());
    expect(orphaned.activeCount).toBe(parked.activeCount);
    expect(
      asRecords(orphaned.parked, "orphaned.parked").some((entry) => entry.indexName === "keep_1"),
    ).toBe(true);

    await coll.drop().catch(() => {});
  });

  // #270. The window is frozen at hide time on purpose, and until now the only
  // exit for an owner who already knew was to cancel the drop — which
  // re-proposes it later and recomputes the same window from the same history.
  it("shortens a pending drop's observe window to the floor, and never past it", async () => {
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "HIDDEN",
        database: "inttest",
        collection: "expedite",
        indexName: "expedite_1",
        rationale: "no recorded usage",
        score: 61,
        estimatedBytesSaved: 2048,
        // Hidden three and a half days ago on a sixty-day window. The half is
        // deliberate: the floor rounds UP, so a fixture sitting exactly on a day
        // boundary is 3 or 4 depending on how long the insert took.
        hiddenAt: new Date(Date.now() - 3.5 * 86_400_000),
        observeDays: 60,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    // No `days`: the api takes the floor, so the dashboard never computes it.
    const res = await api(`/recommendations/${rec.id}/observe-window`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const shortened = asRecord(await res.json());
    // Four, not three: the floor is the time already served rounded up, so the
    // drop is due in about half a day rather than the instant this returns.
    // Rounding the other way would make "shorten" mean "drop at the next tick",
    // with no interval in which anyone could change their mind.
    expect(shortened.observeDays).toBe(4);
    expect(shortened.observeReason).toContain("by an owner");
    // Still HIDDEN: what ended is the observation, not the pipeline. The change
    // window and the regression gate are still ahead of it.
    expect(shortened.state).toBe("HIDDEN");

    // Asking again is a no-op that says so rather than silently succeeding — the
    // window is already at the floor, and there is nothing left to shorten.
    const again = await api(`/recommendations/${rec.id}/observe-window`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(400);

    // Lengthening is refused here even though it is a perfectly good number:
    // that is what the policy baseline is for.
    const longer = await api(`/recommendations/${rec.id}/observe-window`, owner, {
      method: "POST",
      body: JSON.stringify({ days: 90 }),
    });
    expect(longer.status).toBe(400);

    await db.delete(recommendations).where(eq(recommendations.id, rec.id));
  });
});

describe("auto-approval is one threshold", () => {
  it("means never at null, everything at 0, and never promotes an advisory", async () => {
    const org = asRecord(await (await api("/org", owner)).json());
    const [row] = await db
      .insert(clusters)
      .values({
        orgId: asString(org.id),
        name: "Threshold Cluster",
        sealedDek: Buffer.alloc(1),
        sealedData: Buffer.alloc(1),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("failed to insert cluster");
    const thresholdId = row.id;
    createdClusterIds.push(thresholdId);

    const seed = async () => {
      await db.delete(recommendations).where(eq(recommendations.clusterId, thresholdId));
      await db.insert(recommendations).values([
        {
          clusterId: thresholdId,
          type: "DROP_UNUSED",
          state: "PROPOSED",
          database: "inttest",
          collection: "orders",
          indexName: "weak_1",
          rationale: "low confidence",
          score: 40,
          estimatedBytesSaved: 1024,
        },
        {
          clusterId: thresholdId,
          type: "DROP_UNUSED",
          state: "PROPOSED",
          database: "inttest",
          collection: "orders",
          indexName: "strong_1",
          rationale: "high confidence",
          score: 90,
          estimatedBytesSaved: 1024,
        },
        {
          clusterId: thresholdId,
          type: "ADVISORY_REVIEW",
          state: "PROPOSED",
          database: "inttest",
          collection: "orders",
          indexName: "unique_1",
          rationale: "protected index, unused",
          score: 95,
          estimatedBytesSaved: 1024,
        },
        // The promotion floor (#434). Same score as strong_1, and the only
        // difference is how long the usage claim behind it was watched for: three
        // days clears the proposal gate and never the unattended one.
        {
          clusterId: thresholdId,
          type: "DROP_UNUSED",
          state: "PROPOSED",
          database: "inttest",
          collection: "orders",
          indexName: "thin_1",
          rationale: "high confidence, thin history",
          score: 90,
          estimatedBytesSaved: 1024,
          evidenceDays: 3,
        },
        {
          clusterId: thresholdId,
          type: "DROP_UNUSED",
          state: "PROPOSED",
          database: "inttest",
          collection: "orders",
          indexName: "seasoned_1",
          rationale: "high confidence, week of history",
          score: 90,
          estimatedBytesSaved: 1024,
          evidenceDays: 7,
        },
      ]);
    };
    const approvedNames = async (): Promise<string[]> => {
      const rows = await db
        .select()
        .from(recommendations)
        .where(
          and(eq(recommendations.clusterId, thresholdId), eq(recommendations.state, "APPROVED")),
        );
      return rows.map((r) => r.indexName).sort();
    };
    await seed();
    await promoteByScore(db, thresholdId, null);
    expect(await approvedNames()).toEqual([]);

    await seed();
    await promoteByScore(db, thresholdId, 70);
    // strong_1 carries no span at all, which reads as eligible: a NULL means the
    // finding does not rest on one, or predates the column. seasoned_1 has the
    // week the floor asks for. thin_1 scores the same as both and has three days.
    expect(await approvedNames()).toEqual(["seasoned_1", "strong_1"]);

    await seed();
    await promoteByScore(db, thresholdId, 0);
    // Everything except the advisory, which no setting may promote — an
    // approved advisory leaves the PROPOSED set classify refreshes — and except
    // thin_1: the history floor is not a threshold, so 0 does not open it.
    expect(await approvedNames()).toEqual(["seasoned_1", "strong_1", "weak_1"]);

    // And the threshold applyCluster reads is the stored policy value.
    await db.insert(policies).values({ clusterId: thresholdId, autoApplyScore: 95 });
    await seed();
    await applyCluster(db, thresholdId).catch(() => {
      // The fixture's sealed bytes are dummies, so opening a session fails —
      // after the promotion, which is the step under test.
    });
    expect(await approvedNames()).toEqual([]);
  });
});

describe("the observe window can see a query that fails", () => {
  // The gate that decides whether a hidden index gets dropped measures latency,
  // and a failed query is not slow — it is fast. So this is the one signal that
  // can tell a hide which BROKE the workload from a hide that improved it, and it
  // is worth proving against a real mongod rather than a double: the marker is
  // `ok: 0` on a profiler document, and nothing about $collStats records it.
  const DB = "intfail";
  const QUIET_DB = "intfail_quiet";
  const COLL = "fail_probe";

  // Its own databases, because system.profile is per-database and inttest's ring
  // is shared by the workload tests above. The cost of that is these two joining
  // the cluster's database list, which "choosing which databases to observe"
  // asserts exactly — so they go away again before it runs.
  afterAll(async () => {
    await mongo
      .db(DB)
      .dropDatabase()
      .catch(() => undefined);
    await mongo
      .db(QUIET_DB)
      .dropDatabase()
      .catch(() => undefined);
  });

  it("counts failed operations for a namespace, and only since the instant asked", async () => {
    const collector = new MongoIndexCollector(mongo);
    const db_ = mongo.db(DB);
    await db_.collection(COLL).deleteMany({});
    await db_.collection(COLL).insertMany([{ name: "beans and rice" }, { name: "spicy noodle" }]);
    await db_.collection(COLL).createIndex({ name: "text" }, { name: "name_text" });
    // Its own database, so the capped profiler ring is this test's alone —
    // system.profile is per-database, and inttest is shared by everything above.
    await db_.command({ profile: 2 });
    try {
      // A working $text query first, so "no failures" is a reading and not an
      // empty ring.
      expect(await db_.collection(COLL).countDocuments({ $text: { $search: "beans" } })).toBe(1);
      const before = await collector.collectFailedOps(DB, COLL, 0);
      expect(before).not.toBeNull();
      expect(before?.failed).toBe(0);

      // Hide the text index and the same query stops working. Not slows —
      // NoQueryExecutionPlans (291), "need exactly one text index for $text query".
      await db_.command({ collMod: COLL, index: { name: "name_text", hidden: true } });
      const hiddenAt = Date.now();
      for (let i = 0; i < 3; i += 1) {
        await expect(
          db_.collection(COLL).countDocuments({ $text: { $search: "beans" } }),
        ).rejects.toThrow();
      }

      const after = await collector.collectFailedOps(DB, COLL, hiddenAt - 1000);
      expect(after?.failed).toBeGreaterThanOrEqual(3);
      // The ring reaches back at least to the working query, so its zero above was
      // an observation rather than a blind spot.
      expect(after?.reachMs).toBeLessThanOrEqual(hiddenAt);

      // And the `since` filter is real: nothing failed after the future.
      const later = await collector.collectFailedOps(DB, COLL, Date.now() + 60_000);
      expect(later?.failed).toBe(0);

      // The verdict the pipeline actually acts on.
      const verdict = judgeFailures(
        { failed: before?.failed ?? 0, reachMs: before?.reachMs ?? 0 },
        after,
        hiddenAt,
      );
      expect(verdict).toMatchObject({ kind: "INTRODUCED", failed: after?.failed });
    } finally {
      await db_.command({ profile: 0 }).catch(() => undefined);
      await db_
        .command({ collMod: COLL, index: { name: "name_text", hidden: false } })
        .catch(() => undefined);
    }
  });

  // Nothing turned the profiler on, which is the state most clusters are in — and
  // it must read as "no source", never as "no failures" (D19).
  it("reports no source rather than a clean window when the profiler is off", async () => {
    const collector = new MongoIndexCollector(mongo);
    await mongo.db(QUIET_DB).collection("untouched").insertOne({ n: 1 });
    expect(await collector.collectFailedOps(QUIET_DB, "untouched", 0)).toBeNull();
  });
});

describe("workload collection is batched", () => {
  it("reads the cluster-wide store once and slices it per namespace", async () => {
    const collector = new MongoIndexCollector(mongo);
    const targets = [
      { database: "inttest", collection: "orders" },
      { database: "inttest", collection: "carts" },
    ];

    // Count the aggregates this run issues. $queryStats needs mongo 8.0+ for
    // plan metrics and a non-zero rate limit; when it is unusable the call falls
    // through to the profiler per namespace, which is the behaviour to keep.
    let adminAggregates = 0;
    const db = mongo.db.bind(mongo);
    const counting = (name: string) => {
      const handle = db(name);
      if (name !== "admin") return handle;
      const aggregate = handle.aggregate.bind(handle);
      return Object.assign(handle, {
        aggregate: (pipeline: Record<string, unknown>[]) => {
          adminAggregates += 1;
          return aggregate(pipeline);
        },
      });
    };
    Object.assign(mongo, { db: counting });
    try {
      const workload = await collector.collectWorkload(targets);
      // One read of the whole store, not one per namespace.
      expect(adminAggregates).toBeLessThanOrEqual(1);
      // Every namespace asked for gets an entry, and nothing else does.
      expect([...workload.keys()].sort()).toEqual(
        targets.map((t) => workloadKey(t.database, t.collection)).sort(),
      );
    } finally {
      Object.assign(mongo, { db });
    }
  });

  it("asks for nothing when there are no targets", async () => {
    const collector = new MongoIndexCollector(mongo);
    expect((await collector.collectWorkload([])).size).toBe(0);
  });

  it("keeps each namespace's shapes to itself, and drives a real suggest run", async () => {
    // $queryStats records nothing until the sampling rate is lifted.
    await mongo
      .db("admin")
      .command({ setParameter: 1, internalQueryStatsRateLimit: -1 })
      .catch(() => {});

    // Two collections, both over the trivial-size floor so the eligibility pass
    // reads a workload for them, each queried on a DIFFERENT field. Four
    // executions is nowhere near the cost gate, so no create is expected — what
    // is under test here is that each namespace gets its own shapes.
    const docs = Array.from({ length: 1200 }, (_, i) => ({ i, status: "open", tier: "gold" }));
    for (const name of ["wl_orders", "wl_carts"]) {
      await mongo.db("inttest").collection(name).deleteMany({});
      await mongo.db("inttest").collection(name).insertMany(docs);
    }
    for (let run = 0; run < 4; run++) {
      await mongo.db("inttest").collection("wl_orders").find({ status: "open" }).toArray();
      await mongo.db("inttest").collection("wl_carts").find({ tier: "gold" }).toArray();
    }

    const collector = new MongoIndexCollector(mongo);
    const workload = await collector.collectWorkload([
      { database: "inttest", collection: "wl_orders" },
      { database: "inttest", collection: "wl_carts" },
    ]);
    const orders = workload.get(workloadKey("inttest", "wl_orders")) ?? [];
    const carts = workload.get(workloadKey("inttest", "wl_carts")) ?? [];
    // The orders shape filters on `status`, the carts shape on `tier`. If the
    // store were sliced wrongly, each namespace would carry the other's field.
    expect(orders.every((shape) => !shape.equality.includes("tier"))).toBe(true);
    expect(carts.every((shape) => !shape.equality.includes("status"))).toBe(true);
    if (orders.length > 0) expect(orders.some((s) => s.equality.includes("status"))).toBe(true);
    if (carts.length > 0) expect(carts.some((s) => s.equality.includes("tier"))).toBe(true);

    // And the restructured suggest run completes against a real cluster —
    // WITHOUT switching workload analysis on first, because it is on by default
    // now (#258). The pass used to need a policy row saying `true`, and a new
    // cluster has no policy row at all, which is precisely the cluster the
    // create side had the most to say about and said nothing on.
    // Returns { created, instantApproved } since the analysis got a wall clock:
    // the build it can auto-approve moved out to the caller so a budget can never
    // cut one off. `created` is the number this line has always been about.
    expect((await suggestForCluster(db, clusterId)).created).toBeGreaterThanOrEqual(0);

    // And it now leaves a record of what it SAW, not only of what it proposed
    // (#432).
    //
    // Conditional on the store having reported a SCANNING shape, and that is not
    // hedging — it is the version matrix. `$queryStats` carries `docsExamined`
    // only from mongo 8.0, and this adapter derives `collscan` from
    // `keysExamined === 0 && docsExamined > 0` (mongo/collector.ts), so on 6.0
    // and 7.0 the same queries come back as shapes with no measured scan. Both
    // directions are asserted, because "only scanning shapes are stored" is
    // itself the rule: nothing recorded is the right answer when nothing was
    // seen scanning.
    const seenScanning = [...orders, ...carts].filter(isScanning);
    const recorded = await db
      .select()
      .from(workloadShapes)
      .where(eq(workloadShapes.clusterId, clusterId));
    if (seenScanning.length === 0) {
      expect(recorded).toEqual([]);
    } else {
      expect(recorded.length).toBeGreaterThan(0);
      for (const row of recorded) {
        // Every row carries a verdict, and it is one this build knows how to
        // explain — a row with no outcome would be the silence the whole feature
        // exists to end.
        expect(outcomeOf(row.outcome)).not.toBeNull();
        expect(row.observations).toBeGreaterThan(0);
        expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.firstSeenAt.getTime());
      }
      // The storage decision (D128): `constants` carries real customer VALUES
      // and is dropped on the way in. These queries filtered on literal
      // strings, and the profiler is the source that would have captured them.
      const stored = JSON.stringify(recorded.map((row) => row.shape));
      expect(stored).not.toContain("gold");
      expect(stored).not.toContain("open");

      // A second pass extends the rows it already has rather than adding more:
      // one row per SHAPE, not one per pass, which is what stops this table
      // growing with the cadence (D39's argument, reached by a shorter route).
      await suggestForCluster(db, clusterId);
      const again = await db
        .select()
        .from(workloadShapes)
        .where(eq(workloadShapes.clusterId, clusterId));
      expect(again.length).toBe(recorded.length);
      expect(Math.max(...again.map((row) => row.observations))).toBeGreaterThan(1);
    }

    // Off is still off, and now it is a decision the data records rather than
    // the absence of one. Asserted through the api so the round trip that stores
    // it is the thing under test.
    await api(`/clusters/${clusterId}/policy`, owner, {
      method: "PUT",
      body: JSON.stringify({
        workloadAnalysis: false,
        instantCreate: false,
        observeWindowDays: 7,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: null,
        changeWindowEndHour: null,
      }),
    });
    // Zero without dialling: the guard is the first thing the pass does, so a
    // cluster switched off costs one row read and no connection.
    expect((await suggestForCluster(db, clusterId)).created).toBe(0);
  });
});

// The post-build watch measures each index against a baseline taken at that
// index's OWN build time, so build #2 is judged against a collection already
// carrying #1 (#282). Three builds that each add a defensible 15% are three
// STABLE verdicts and a collection half again slower than where it started.
describe("builds that are individually fine and cumulatively are not", () => {
  it("reports the collection and stops building on it unattended", async () => {
    // Enough separate write COMMANDS for a judgement: latencyStats counts
    // operations, so one insertMany of forty documents is one op and forty
    // inserts are forty. minWindowOps is 20.
    const orders = mongo.db("inttest").collection("orders");
    for (let i = 0; i < 60; i++) await orders.insertOne({ cumulative: i });

    // Read the collection's real counters through the same collector the job
    // uses, so the baselines below sit relative to a live reading rather than to
    // numbers invented here. They only ever grow, so a fixture placed under this
    // reading stays under whatever finalize sees a moment later.
    const probe = await openClusterSession(db, clusterId);
    const { writes } = await probe.session.collector.collectionLatency("inttest", "orders");
    await probe.release();
    expect(writes.ops).toBeGreaterThan(45);
    const window = 25;
    // A baseline that makes the window read exactly `ratio` times slower than the
    // baseline average, over the same window. Solving
    // (L - X) / window = ratio * X / B for X, where B is the baseline's op count
    // and L the current cumulative latency — so the fixture states the RATIO it
    // wants and the arithmetic follows, rather than the other way round.
    const baselineLatencyFor = (ratio: number): number => {
      const b = writes.ops - window;
      return Math.round((b * writes.latencyMicros) / (b + ratio * window));
    };

    const built = new Date(Date.now() - 60 * 86_400_000);
    const older = new Date(Date.now() - 90 * 86_400_000);
    // The run's start: a baseline so far below the current reading that the
    // collection is unambiguously slower than it was.
    const [first] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "CREATE",
        state: "ACTIVE",
        source: "WORKLOAD",
        database: "inttest",
        collection: "orders",
        indexName: "cumulative_first_1",
        rationale: "first of a run",
        score: 70,
        builtAt: older,
        // 1.42x, which is the band this change adds and the reason it is a band.
        // The oldest row's OWN watch reads the same two numbers at 1.5, so
        // anything above that is already caught — by rolling back the OLDEST
        // index, which is the attribution the issue warns about. Below 1.3
        // nothing fires at all. In between, only the collection-level check
        // speaks, and it reports rather than undoes.
        baselineWriteOps: writes.ops - window,
        baselineWriteLatency: baselineLatencyFor(1.42),
      })
      .returning();
    // The one graduating, whose OWN baseline says writes are fine: its window
    // average lands well under the 1.5x its own gate asks for.
    const [second] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "CREATE",
        state: "ACTIVE",
        source: "WORKLOAD",
        database: "inttest",
        collection: "orders",
        indexName: "cumulative_second_1",
        rationale: "second of a run",
        score: 70,
        builtAt: built,
        // Its own watch sees 1.05x and is right to: this index did not slow the
        // collection. It is the run it is part of that did.
        baselineWriteOps: writes.ops - window,
        baselineWriteLatency: baselineLatencyFor(1.05),
      })
      .returning();
    if (first === undefined || second === undefined) throw new Error("failed to insert");

    await finalizeCluster(db, clusterId);

    // Its own watch passed — it graduated, baselines cleared.
    const [graduated] = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.id, second.id));
    expect(graduated?.state).toBe("ACTIVE");
    expect(graduated?.baselineWriteOps).toBeNull();

    // And the collection was reported anyway, parked under the empty index name
    // that means "the whole collection".
    const [parked] = await db
      .select()
      .from(indexCooldowns)
      .where(
        and(
          eq(indexCooldowns.clusterId, clusterId),
          eq(indexCooldowns.collection, "orders"),
          eq(indexCooldowns.indexName, ""),
        ),
      );
    expect(parked?.reason).toContain("slower than before the run of builds");
    expect(parked?.until.getTime()).toBeGreaterThan(Date.now());
    // Nothing was rolled back: the newest index is not necessarily the culprit,
    // and undoing the wrong one is worse than saying so.
    expect(graduated?.state).not.toBe("ROLLED_BACK");
    const [firstAfter] = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.id, first.id));
    expect(firstAfter?.state).toBe("ACTIVE");

    // The dashboard names it as the collection rather than as an index.
    const cooldowns = asRecord(await (await api(`/clusters/${clusterId}/cooldowns`, owner)).json());
    const rows = Array.isArray(cooldowns.parked) ? cooldowns.parked.map(asRecord) : [];
    const collectionRow = rows.find((row) => row.wholeCollection === true);
    expect(collectionRow?.collection).toBe("orders");

    // Cleanup: this cluster is the suite's main one and later scenarios read it.
    await db.delete(recommendations).where(eq(recommendations.id, first.id));
    await db.delete(recommendations).where(eq(recommendations.id, second.id));
    await db
      .delete(indexCooldowns)
      .where(
        and(
          eq(indexCooldowns.clusterId, clusterId),
          eq(indexCooldowns.collection, "orders"),
          eq(indexCooldowns.indexName, ""),
        ),
      );
    await mongo
      .db("inttest")
      .collection("orders")
      .deleteMany({ cumulative: { $exists: true } });
  });
});

describe("an index the engine is still watching", () => {
  it("is not proposed for a drop until its post-build watch has passed", async () => {
    const org = asRecord(await (await api("/org", owner)).json());
    const [row] = await db
      .insert(clusters)
      .values({
        orgId: asString(org.id),
        name: "Watch Cluster",
        sealedDek: Buffer.alloc(1),
        sealedData: Buffer.alloc(1),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("failed to insert cluster");
    const watchId = row.id;
    createdClusterIds.push(watchId);

    // Built for a query shape that then went quiet: three clean snapshots, all
    // zero ops, which on their own read as FLAT_ZERO -> DROP_UNUSED.
    // Ten days of collects at 12h intervals: enough span to clear the warm-up
    // (usage findings need a week of history, not just three snapshots).
    const base = Date.now() - 10 * 86_400_000;
    const spec = {
      name: "built_1",
      keys: [{ field: "built", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    const since = new Date(base - 86_400_000).toISOString();
    await insertSnapshots(
      db,
      Array.from({ length: 20 }, (_, i) => ({
        clusterId: watchId,
        database: "inttest",
        collection: "orders",
        indexName: "built_1",
        spec,
        sizeBytes: 4096,
        perMember: [{ member: "m1", ops: 0, since }],
        capturedAt: new Date(base + i * 43_200_000),
      })),
    );

    // The collection has to have been genuinely queried, or the activity gate
    // (correctly) refuses any usage claim about its indexes.
    await insertLatency(
      db,
      Array.from({ length: 20 }, (_, i) => ({
        clusterId: watchId,
        database: "inttest",
        collection: "orders",
        readOps: (i + 1) * 500,
        readLatencyMicros: 100,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date(base + i * 43_200_000),
      })),
    );

    // The engine built it a moment ago, so its write watch is still running.
    const [created] = await db
      .insert(recommendations)
      .values({
        clusterId: watchId,
        type: "CREATE",
        state: "ACTIVE",
        database: "inttest",
        collection: "orders",
        indexName: "built_1",
        rationale: "built from a recurring collection scan",
        score: 70,
        estimatedBytesSaved: 0,
        builtAt: new Date(),
        baselineWriteOps: 100,
        baselineWriteLatency: 5000,
      })
      .returning();
    if (created === undefined) throw new Error("failed to insert recommendation");

    expect(await classifyCluster(db, watchId)).toBe(0);

    // Graduated: watch elapsed, baselines cleared. Now it is an ordinary index
    // and the usual rules apply — the guard must release, not protect forever.
    await db
      .update(recommendations)
      .set({
        builtAt: new Date(Date.now() - 120 * 86_400_000),
        baselineWriteOps: null,
        baselineWriteLatency: null,
      })
      .where(eq(recommendations.id, created.id));

    expect(await classifyCluster(db, watchId)).toBe(1);
    const [proposal] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.clusterId, watchId), eq(recommendations.state, "PROPOSED")));
    expect(proposal?.type).toBe("DROP_UNUSED");
    expect(proposal?.indexName).toBe("built_1");
  });
});

describe("a drop the customer already approved", () => {
  it("is not proposed a second time while it is still on its way out", async () => {
    const org = asRecord(await (await api("/org", owner)).json());
    const [row] = await db
      .insert(clusters)
      .values({
        orgId: asString(org.id),
        name: "Approved Drop Cluster",
        sealedDek: Buffer.alloc(1),
        sealedData: Buffer.alloc(1),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("failed to insert cluster");
    const dupeId = row.id;
    createdClusterIds.push(dupeId);

    // A key-prefix pair: userId_1 is covered by userId_1_name_1, which is a
    // STRUCTURAL finding — it holds on every pass, with no usage history to age
    // out of and nothing about it that stops being true once somebody approves
    // the drop. That is exactly what made the duplicate reproducible.
    const base = Date.now() - 3 * 86_400_000;
    const specFor = (name: string, keys: string[]) => ({
      name,
      keys: keys.map((field) => ({ field, direction: 1 })),
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    });
    await insertSnapshots(
      db,
      ["userId_1", "userId_1_name_1"].flatMap((indexName) =>
        Array.from({ length: 3 }, (_, i) => ({
          clusterId: dupeId,
          database: "inttest",
          collection: "complexes",
          indexName,
          spec: specFor(indexName, indexName === "userId_1" ? ["userId"] : ["userId", "name"]),
          sizeBytes: 8192,
          perMember: [{ member: "m1", ops: 100 }],
          capturedAt: new Date(base + i * 43_200_000),
        })),
      ),
    );

    expect(await classifyCluster(db, dupeId)).toBe(1);
    const [proposal] = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, dupeId));
    expect(proposal?.type).toBe("DROP_REDUNDANT");
    expect(proposal?.indexName).toBe("userId_1");
    if (proposal === undefined) throw new Error("no proposal");

    // What a customer clicking Approve does. The index is still on the cluster —
    // the hide -> observe -> drop path has not run yet — so the engine still sees
    // it as redundant on the next pass.
    const dropsFor = async (): Promise<(typeof recommendations.$inferSelect)[]> =>
      db.select().from(recommendations).where(eq(recommendations.clusterId, dupeId));

    for (const state of ["APPROVED", "HIDDEN"] as const) {
      await db
        .update(recommendations)
        .set({ state, updatedAt: new Date() })
        .where(eq(recommendations.id, proposal.id));
      expect(await classifyCluster(db, dupeId)).toBe(0);
      const rows = await dropsFor();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(proposal.id);
      expect(rows[0]?.state).toBe(state);
    }

    // And it releases rather than protecting forever: a cancelled drop is held
    // off by a cooldown (recordManualVeto), not by the row's own state, so once
    // the row settles the finding is allowed to come back.
    await db
      .update(recommendations)
      .set({ state: "REJECTED", updatedAt: new Date() })
      .where(eq(recommendations.id, proposal.id));
    expect(await classifyCluster(db, dupeId)).toBe(1);
    const after = await dropsFor();
    expect(after).toHaveLength(2);
    expect(after.filter((rec) => rec.state === "PROPOSED")).toHaveLength(1);
  });
});

describe("engine-chosen change window", () => {
  it("derives a window from traffic and serves it on a cluster with no policy row", async () => {
    const org = asRecord(await (await api("/org", owner)).json());
    const [row] = await db
      .insert(clusters)
      .values({
        orgId: asString(org.id),
        name: "Window Cluster",
        sealedDek: Buffer.alloc(1),
        sealedData: Buffer.alloc(1),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("failed to insert cluster");
    const windowClusterId = row.id;
    createdClusterIds.push(windowClusterId);

    // Five days of collects at the 6h cadence. Cumulative counters, quiet
    // overnight (00-06 UTC) and busy through the working day.
    //
    // Anchored to the last few days rather than to a fixed calendar month: the
    // inference reads a bounded window of recent history, because the window is
    // meant to track a workload that shifts. A fixture pinned to June kept working
    // only until June was far enough back to be excluded.
    const perBucket = [40, 900, 1200, 700];
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const start = midnight.getTime() - 6 * 86_400_000;
    let ops = 0;
    const samples = [];
    for (let day = 0; day < 5; day++) {
      for (let bucket = 0; bucket < 4; bucket++) {
        samples.push({
          clusterId: windowClusterId,
          database: "shop",
          collection: "orders",
          readOps: ops,
          readLatencyMicros: 0,
          writeOps: 0,
          writeLatencyMicros: 0,
          capturedAt: new Date(start + day * 86_400_000 + bucket * 6 * 3_600_000),
        });
        ops += perBucket[bucket] ?? 0;
      }
    }
    await insertLatency(db, samples);

    // No policies row exists for this cluster — the engine must create one.
    const inferred = await refreshInferredWindow(db, windowClusterId);
    expect(inferred).toEqual({ startHour: 0, endHour: 6 });

    const policy = asRecord(await (await api(`/clusters/${windowClusterId}/policy`, owner)).json());
    expect(policy.changeWindowStartHour).toBeNull();
    expect(policy.inferredWindowStartHour).toBe(0);
    expect(policy.inferredWindowEndHour).toBe(6);
    expect(String(policy.inferredWindowReason)).toContain("quietest");
  });
});

// The other half of the audit story (#53). `actions` records what the engine did
// to an index; nothing recorded who signed in, who became an owner, or who took a
// cluster's credentials — and the mapping from a better-auth route to a row is
// read off its hook context, which only a real request produces. Late in the file
// on purpose: the scenarios above have already invited, promoted, demoted,
// removed, connected, rotated and flipped a mode, so this asserts the trail those
// left rather than performing them a second time.
describe("security trail", () => {
  async function eventsFor(orgId: string) {
    return (
      await db
        .select()
        .from(securityEvents)
        .where(eq(securityEvents.orgId, orgId))
        .orderBy(desc(securityEvents.createdAt))
    ).map((row) => ({ ...row }));
  }

  it("records signing in, failing to, and signing out", async () => {
    const email = `trail-${Date.now()}@int.test`;
    const signUpRes = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password: "password12345", name: "trail" }),
    });
    expect(signUpRes.status).toBe(200);
    createdEmails.push(email);

    const signIn = async (password: string) =>
      fetch(`${API_BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password }),
      });
    const good = await signIn("password12345");
    expect(good.status).toBe(200);
    const bad = await signIn("not-the-password");
    expect(bad.status).toBe(401);
    const out = await fetch(`${API_BASE}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_ORIGIN,
        cookie: sessionFrom(email, good).cookie,
      },
      body: "{}",
    });
    expect(out.status).toBe(200);

    const rows = (
      await db.select().from(securityEvents).where(eq(securityEvents.actorEmail, email))
    ).map((row) => ({ ...row }));
    const events = rows.map((row) => row.event);
    expect(events).toContain("ACCOUNT_CREATED");
    expect(events).toContain("SIGN_IN");
    expect(events).toContain("SIGN_OUT");

    // The failed one is credited to nobody — whoever it was did not prove they
    // were this account — so it is found by target instead.
    const failed = (
      await db.select().from(securityEvents).where(eq(securityEvents.target, email))
    ).map((row) => ({ ...row }));
    expect(failed.map((row) => row.event)).toContain("SIGN_IN_FAILED");
    const attempt = failed.find((row) => row.event === "SIGN_IN_FAILED");
    expect(attempt?.actorUserId).toBeNull();
    expect(attempt?.actorEmail).toBeNull();
    // Enough to answer "which client, and was it the same one" without a session
    // being resolvable at all.
    expect(attempt?.userAgent === null || typeof attempt?.userAgent === "string").toBe(true);
  });

  it("records who was invited, promoted and removed, and by whom", async () => {
    const rows = await eventsFor(ownerOrgId);
    const events = rows.map((row) => row.event);
    expect(events).toContain("INVITE_CREATED");
    expect(events).toContain("MEMBER_ROLE_CHANGED");
    expect(events).toContain("MEMBER_REMOVED");

    // The point of the table: every one of those names the account that did it.
    for (const row of rows.filter((entry) => entry.event !== "SIGN_IN_FAILED")) {
      expect(row.actorUserId).not.toBeNull();
      expect(row.actorEmail).not.toBeNull();
    }
    const promotion = rows.find((row) => row.event === "MEMBER_ROLE_CHANGED");
    expect(promotion?.actorEmail).toBe(owner.email);
    expect(promotion?.target).not.toBeNull();
    expect(promotion?.metadata).toMatchObject({ role: expect.any(String) });
    const invite = rows.find((row) => row.event === "INVITE_CREATED");
    expect(invite?.metadata).toMatchObject({ role: expect.any(String) });
  });

  it("records what was done to a cluster's access", async () => {
    const rows = await eventsFor(ownerOrgId);
    const events = rows.map((row) => row.event);
    expect(events).toContain("CLUSTER_CONNECTED");
    expect(events).toContain("CLUSTER_MODE_CHANGED");
    expect(events).toContain("CLUSTER_CREDENTIALS_ROTATED");

    const flip = rows.find((row) => row.event === "CLUSTER_MODE_CHANGED");
    expect(flip?.clusterId).toBe(clusterId);
    expect(flip?.metadata).toMatchObject({ readOnly: expect.any(Boolean) });
    expect(flip?.actorEmail).toBe(owner.email);
    // The api's own handlers read Fastify's resolved address, which exists whether
    // or not a proxy is trusted; the better-auth half reads a forwarded header and
    // records nothing without TRUST_PROXY, which this suite does not set. Two
    // sources, and the difference is deliberate — see audit/http-actor.ts.
    expect(flip?.ipAddress).not.toBeNull();

    // Disconnecting deletes the cluster, so the row that records it cannot point
    // at one — it carries the id in its metadata instead, and it is the only thing
    // left about that cluster afterwards.
    const gone = rows.find((row) => row.event === "CLUSTER_DISCONNECTED");
    if (gone !== undefined) {
      expect(gone.clusterId).toBeNull();
      expect(gone.metadata).toMatchObject({ clusterId: expect.any(String) });
    }
  });

  // #158. Everything above asserts against the TABLE, because until now nothing
  // read it back. These assert against the route a reader actually uses.
  it("serves the org's trail to an owner, newest first, with the true total", async () => {
    const res = await api("/security-events", owner);
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const events = asRecords(body.events, "body.events");
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(SECURITY_TRAIL_PAGE);
    // Against the table, so the count is the org's trail and not the page.
    expect(body.total).toBe((await eventsFor(ownerOrgId)).length);
    const stamps = events.map((row) => Date.parse(String(row.createdAt)));
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
    // Scoped to the caller's org. The actor index crosses orgs on purpose; a
    // tenant's read must not.
    const ids = new Set((await eventsFor(ownerOrgId)).map((row) => row.id));
    expect(events.every((row) => ids.has(String(row.id)))).toBe(true);
  });

  it("filters by kind and by actor, at the api rather than in the browser", async () => {
    const byKind = asRecord(
      await (await api("/security-events?event=CLUSTER_MODE_CHANGED", owner)).json(),
    );
    const kinds = asRecords(byKind.events, "byKind.events").map((row) => row.event);
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(["CLUSTER_MODE_CHANGED"]));
    // The total is of what MATCHES, so a filtered page cannot report the whole
    // trail's size beside a handful of rows.
    expect(byKind.total).toBe(kinds.length);

    const ownerId = (await eventsFor(ownerOrgId)).find(
      (row) => row.actorUserId !== null,
    )?.actorUserId;
    if (ownerId === undefined || ownerId === null) throw new Error("no actor in the trail");
    const byActor = asRecord(
      await (await api(`/security-events?actorUserId=${ownerId}`, owner)).json(),
    );
    const actors = asRecords(byActor.events, "byActor.events").map((row) => row.actorUserId);
    expect(actors.length).toBeGreaterThan(0);
    expect(new Set(actors)).toEqual(new Set([ownerId]));

    // A kind nobody has performed answers with an empty page and a zero total,
    // not with the unfiltered trail.
    const none = asRecord(await (await api("/security-events?event=ORG_DELETED", owner)).json());
    expect(none.events).toEqual([]);
    expect(none.total).toBe(0);
  });

  // Keyset, not offset: the trail grows at the head, and an offset page would
  // repeat the row a fresh sign-in pushed across the boundary.
  it("pages backwards through the trail without repeating or skipping a row", async () => {
    // One row per page, by asking for the page after each row in turn — the
    // cursor is what is under test, not the page size.
    const all = await eventsFor(ownerOrgId);
    if (all.length < 3) throw new Error("not enough trail to page through");
    const first = asRecord(await (await api("/security-events", owner)).json());
    const firstIds = asRecords(first.events, "first.events").map((row) => row.id);
    expect(firstIds[0]).toBe(all[0]?.id);

    const cursor = all[0];
    if (cursor === undefined) throw new Error("no cursor row");
    const second = asRecord(
      await (
        await api(
          `/security-events?beforeCreatedAt=${encodeURIComponent(cursor.createdAt.toISOString())}&beforeId=${cursor.id}`,
          owner,
        )
      ).json(),
    );
    const secondIds = asRecords(second.events, "second.events").map((row) => row.id);
    // The cursor row itself is excluded, and the next one is the row after it.
    expect(secondIds).not.toContain(cursor.id);
    expect(secondIds[0]).toBe(all[1]?.id);
    // The total does not change with the page: it counts the filter, not the
    // slice, so "showing 100 of 4,312" stays true on page four.
    expect(second.total).toBe(first.total);
  });

  // The load-bearing rule of the whole route. Everywhere else a member reads
  // everything in their org; here every row carries a colleague's address.
  //
  // Every account owns the org its sign-up made, so a session read from where it
  // is standing answers 200 about its OWN trail and proves nothing. The refusal
  // only means something once the caller is standing in the owner's org holding
  // the member role — which is a membership row and an active org, both put in
  // place here and both taken out again, so nothing after this inherits either.
  //
  // The row goes in directly rather than through an invitation: this file is one
  // sequential narrative sharing one address with the auth rate limiter, and four
  // more auth POSTs here showed up as unrelated failures three describes later.
  it("refuses a member, because this is who-did-what and not team-wide reading", async () => {
    const ownOrgId = asString(asRecord(await (await api("/org", member)).json()).id);
    expect(ownOrgId).not.toBe(ownerOrgId);
    // The control: as the owner of their own org, the route answers. It is what
    // makes the refusal below about the role rather than about a broken route.
    expect((await api("/security-events", member)).status).toBe(200);

    const [account] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, member.email))
      .limit(1);
    if (account === undefined) throw new Error("no user row for the member session");
    await db
      .insert(members)
      .values({ orgId: ownerOrgId, userId: account.id, role: "member" })
      .onConflictDoNothing();
    try {
      const into = await authPost("/organization/set-active", member, {
        organizationId: ownerOrgId,
      });
      expect(into.status).toBe(200);
      const res = await api("/security-events", member);
      expect(res.status).toBe(403);
    } finally {
      const back = await authPost("/organization/set-active", member, {
        organizationId: ownOrgId,
      });
      expect(back.status).toBe(200);
      await db
        .delete(members)
        .where(and(eq(members.orgId, ownerOrgId), eq(members.userId, account.id)));
    }
  });

  // An audit table is read by people who are not meant to be able to use what it
  // records. A connection string or a session token in `metadata` would hand them
  // exactly what the rest of this api goes to some trouble to seal.
  it("copies no credential into the trail", async () => {
    const rows = await db.select().from(securityEvents);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain("mongodb://");
    expect(serialised).not.toContain("mongodb+srv://");
    expect(serialised).not.toContain("password12345");
    for (const row of rows) {
      expect(JSON.stringify(row.metadata ?? {})).not.toMatch(/token|secret|connectionString/i);
    }
  });
});

// Its own api instance at the production default. The shared one raises the
// budget so the suite can sign up an account per scenario, which would make
// this pass or fail on the wrong number — the limit under test is the one a
// deployment actually ships with.
describe("rate limiting", () => {
  it("throttles auth brute force with 429 at the shipped default", async () => {
    const port = API_PORT + 2;
    const server = await startApi({ AUTH_RATE_LIMIT_MAX: "20" }, port);
    try {
      let limited = false;
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`http://localhost:${port}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: WEB_ORIGIN },
          body: JSON.stringify({ email: "no@int.test", password: "wrongwrong123" }),
        });
        if (res.status === 429) {
          limited = true;
          break;
        }
      }
      expect(limited).toBe(true);
    } finally {
      await stopApi(server);
    }
  });

  // The half of #54 that arithmetic alone does not cover: the counters used to
  // live in each process's memory, so `api.replicas: 2` meant twice the
  // configured limit and which pod a request landed on decided which bucket it
  // spent. Two api processes here ARE two replicas — same database, nothing
  // shared but that — and the second must refuse on a budget the first spent.
  //
  // NODE_ENV=production because better-auth enables its own limiter for
  // production only (the api image sets it), and ALLOW_INSECURE_AUTH_URL because
  // this one answers over http. AUTH_RATE_LIMIT_MAX is deliberately above 1 so
  // the first request to the SECOND process passes that process's own Fastify
  // budget: a 429 from it can then only have come from the shared count.
  it("spends one budget across two replicas, not one each", async () => {
    const shared = {
      NODE_ENV: "production",
      ALLOW_INSECURE_AUTH_URL: "true",
      AUTH_RATE_LIMIT_MAX: "3",
    };
    const [portA, portB] = [API_PORT + 3, API_PORT + 4];
    const replicaA = await startApi(shared, portA);
    const replicaB = await startApi(shared, portB);
    const attempt = (port: number) =>
      fetch(`http://localhost:${port}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        body: JSON.stringify({ email: "replicas@int.test", password: "wrongwrong123" }),
      });
    try {
      // Spend the budget on A. Bounded rather than while(true): a run that never
      // throttles has to fail the assertion below, not hang.
      let spentOnA = false;
      for (let i = 0; i < 10 && !spentOnA; i += 1) {
        spentOnA = (await attempt(portA)).status === 429;
      }
      expect(spentOnA).toBe(true);

      // B has served nothing and its own memory holds no count for this address.
      const onB = await attempt(portB);
      expect(onB.status).toBe(429);

      // And the count is where it can be shared from, keyed by path.
      const rows = await db.execute<{ key: string; count: number }>(
        sql`select key, count from rate_limit where key like '%|/sign-in/email'`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);
    } finally {
      await stopApi(replicaA);
      await stopApi(replicaB);
      // Otherwise the next scenario that signs in inherits a spent budget.
      await db.execute(sql`delete from rate_limit`);
    }
  });
});

// A job that burns its last attempt keeps its row forever — the one table with
// no retention. An offboarded cluster or a week-long outage leaves debris in
// the control-plane database that nothing was ever going to remove.
describe("dead-letter retention", () => {
  it("removes permanently failed jobs past the window and keeps recent ones", async () => {
    const utils = await makeWorkerUtils({ connectionString: databaseUrl() });
    let staleId: string;
    let freshId: string;
    let liveId: string;
    try {
      const stale = await utils.addJob("collect", { clusterId });
      const fresh = await utils.addJob("collect", { clusterId });
      const live = await utils.addJob("collect", { clusterId });
      staleId = stale.id;
      freshId = fresh.id;
      liveId = live.id;
    } finally {
      await utils.release();
    }

    // Built with SQL rather than permanentlyFailJobs, which is an operator
    // action with its own intermediate state (it leaves attempts below
    // max_attempts and the row locked). What accumulates in a real deployment
    // is a job the worker gave up on: attempts exhausted, lock released. That
    // is what the prune targets, so that is what the fixture has to be.
    //
    // Back-dated rather than slept on: the window is the thing under test, and
    // a test that only passes because time passed is not testing it.
    const exhaust = (id: string, age: string) =>
      db.execute(
        sql`update graphile_worker._private_jobs
            set attempts = max_attempts, locked_at = null, locked_by = null,
                updated_at = now() - ${sql.raw(`interval '${age}'`)}
            where id::text = ${id}`,
      );
    await exhaust(staleId, "91 days");
    await exhaust(freshId, "1 hour");

    expect(await pruneDeadLetterJobs(db)).toBeGreaterThanOrEqual(1);

    const remaining = await db.execute(
      sql`select id::text as id from graphile_worker.jobs
          where id::text in (${staleId}, ${freshId}, ${liveId})`,
    );
    const ids = remaining.rows.map((row) => row.id);
    expect(ids).not.toContain(staleId);
    // A failure from this morning is still worth reading; only old debris goes.
    expect(ids).toContain(freshId);
    expect(ids).toContain(liveId);

    await db.execute(
      sql`delete from graphile_worker._private_jobs where id::text in (${freshId}, ${liveId})`,
    );
  });
});

describe("a worker that died holding a queue", () => {
  it("frees the lock once it is old enough, and leaves a live one alone", async () => {
    const utils = await makeWorkerUtils({ connectionString: databaseUrl() });
    const stuckQueue = `collect:${clusterId}:stuck`;
    const liveQueue = `collect:${clusterId}:live`;
    let stuckId: string;
    let liveId: string;
    try {
      // Named queues, because that is the unit graphile-worker serialises on
      // and the unit that gets wedged: one per cluster per pass in production.
      stuckId = (await utils.addJob("collect", { clusterId }, { queueName: stuckQueue })).id;
      liveId = (await utils.addJob("collect", { clusterId }, { queueName: liveQueue })).id;
    } finally {
      await utils.release();
    }

    // What a SIGKILL leaves behind: the queue and the job still marked as held
    // by a worker that no longer exists. Back-dated rather than slept on — the
    // four-hour threshold is the thing under test.
    const hold = (queue: string, jobId: string, age: string) =>
      db
        .execute(
          sql`update graphile_worker._private_job_queues
              set locked_at = now() - ${sql.raw(`interval '${age}'`)}, locked_by = 'otpool-gone'
              where queue_name = ${queue}`,
        )
        .then(() =>
          db.execute(
            sql`update graphile_worker._private_jobs
                set locked_at = now() - ${sql.raw(`interval '${age}'`)}, locked_by = 'otpool-gone'
                where id::text = ${jobId}`,
          ),
        );
    await hold(stuckQueue, stuckId, "6 hours");
    await hold(liveQueue, liveId, "10 minutes");

    // is_available is `generated always as (locked_at IS NULL)` — there is no
    // time term in it, which is the whole defect: without a reset both of these
    // stay false forever and the jobs behind them are never claimed again.
    const availability = async (): Promise<Record<string, boolean>> => {
      const rows = await db.execute<{ queue_name: string; is_available: boolean }>(
        sql`select queue_name, is_available from graphile_worker._private_job_queues
            where queue_name in (${stuckQueue}, ${liveQueue})`,
      );
      return Object.fromEntries(rows.rows.map((row) => [row.queue_name, row.is_available]));
    };
    expect(await availability()).toEqual({ [stuckQueue]: false, [liveQueue]: false });

    const freed = await releaseStaleLocks(db);
    expect(freed).toContain(stuckQueue);
    // A collect against a large cluster legitimately runs for minutes. Ten
    // minutes in, the worker is working, and taking its queue away would hand
    // the same job to a second one.
    expect(freed).not.toContain(liveQueue);
    expect(await availability()).toEqual({ [stuckQueue]: true, [liveQueue]: false });

    // The job's own lock has to go with the queue's, or it stays unclaimable on
    // a queue that is now free — and run_at is pushed to the present so a job
    // unlocked from six hours ago does not jump ahead of everything since.
    const jobs = await db.execute<{ id: string; locked_at: Date | null; ahead: boolean }>(
      sql`select id::text as id, locked_at, run_at < now() - interval '1 minute' as ahead
          from graphile_worker._private_jobs where id::text in (${stuckId}, ${liveId})`,
    );
    const stuck = jobs.rows.find((row) => row.id === stuckId);
    const live = jobs.rows.find((row) => row.id === liveId);
    expect(stuck?.locked_at).toBeNull();
    expect(stuck?.ahead).toBe(false);
    expect(live?.locked_at).not.toBeNull();

    await db.execute(
      sql`delete from graphile_worker._private_jobs where id::text in (${stuckId}, ${liveId})`,
    );
    await db.execute(
      sql`delete from graphile_worker._private_job_queues
          where queue_name in (${stuckQueue}, ${liveQueue})`,
    );
  });

  // #412: a pass with a wall clock does not need the library's four hours.
  //
  // Four hours was right while any pass might legitimately be hours long. Since
  // #407 a read-only pass gives up after five minutes, so a `collect` lock older
  // than three budgets is abandoned by definition — and waiting four hours to
  // say so is what let a day of duplicates pile up in production, because
  // `add_job`'s dedup silently declines to replace a LOCKED job.
  //
  // `apply` keeps the four hours, and must: it has no budget precisely because a
  // build legitimately runs for tens of minutes (#410).
  it("frees a budgeted pass sooner than an unbudgeted one", async () => {
    const utils = await makeWorkerUtils({ connectionString: databaseUrl() });
    const budgetedQueue = `collect:${clusterId}:budgeted`;
    const buildQueue = `apply:${clusterId}:build`;
    let budgetedId: string;
    let buildId: string;
    try {
      budgetedId = (await utils.addJob("collect", { clusterId }, { queueName: budgetedQueue })).id;
      buildId = (await utils.addJob("apply", { clusterId }, { queueName: buildQueue })).id;
    } finally {
      await utils.release();
    }

    // Twenty minutes: past three five-minute budgets, nowhere near four hours.
    // The whole point of the change is that these two are now treated apart.
    const hold = (queue: string, jobId: string) =>
      db
        .execute(
          sql`update graphile_worker._private_job_queues
              set locked_at = now() - interval '20 minutes', locked_by = 'gone'
              where queue_name = ${queue}`,
        )
        .then(() =>
          db.execute(
            sql`update graphile_worker._private_jobs
                set locked_at = now() - interval '20 minutes', locked_by = 'gone'
                where id::text = ${jobId}`,
          ),
        );
    await hold(budgetedQueue, budgetedId);
    await hold(buildQueue, buildId);

    const freed = await releaseStaleLocks(db);

    expect(freed).toContain(budgetedQueue);
    // The one that would be a real bug to free: a build twenty minutes in is
    // working, and taking its queue away starts a second one beside it.
    expect(freed).not.toContain(buildQueue);

    // The job's lock has to follow the queue's, or freeing the queue buys
    // nothing — the job stays unclaimable on a queue that is now available.
    const jobs = await db.execute<{ id: string; locked_at: Date | null }>(
      sql`select id::text as id, locked_at from graphile_worker._private_jobs
          where id::text in (${budgetedId}, ${buildId})`,
    );
    expect(jobs.rows.find((row) => row.id === budgetedId)?.locked_at).toBeNull();
    expect(jobs.rows.find((row) => row.id === buildId)?.locked_at).not.toBeNull();

    await db.execute(
      sql`delete from graphile_worker._private_jobs where id::text in (${budgetedId}, ${buildId})`,
    );
    await db.execute(
      sql`delete from graphile_worker._private_job_queues
          where queue_name in (${budgetedQueue}, ${buildQueue})`,
    );
  });
});

// Which source answers depends on the server, and CI runs the whole matrix.
// $queryStats exists from 6.0 but carries no plan metrics until 8.0, so below
// 8.0 it cannot tell a scan from an index hit and the profiler must answer
// instead. Getting that backwards is silent: the store returns shapes, the
// fallback never runs, and the cluster simply stops producing create
// recommendations. This asserts the finding survives on whichever path is
// correct for the server actually running.
describe("workload source follows the server version", () => {
  it("finds an in-memory sort via $queryStats on 8.0+, via the profiler below it", async () => {
    const build = await mongo.db("admin").command({ buildInfo: 1 });
    const version = parseServerVersion(asRecord(build).version);
    await mongo
      .db("admin")
      .command({ setParameter: 1, internalQueryStatsRateLimit: -1 })
      .catch(() => {});
    await mongo
      .db("inttest")
      .command({ profile: 2 })
      .catch(() => {});

    const coll = mongo.db("inttest").collection("wl_sorts");
    await coll.deleteMany({});
    await coll.insertMany(
      Array.from({ length: 1500 }, (_, i) => ({ status: i % 5, at: new Date(i * 1000) })),
    );
    await coll.createIndex({ status: 1 }, { name: "status_1" });
    // status_1 finds the documents; nothing can order them, so the server sorts
    // in memory. keysExamined > 0, so no scan test sees this.
    for (let run = 0; run < 5; run++) {
      await coll.find({ status: 2 }).sort({ at: -1 }).toArray();
    }

    const collector = new MongoIndexCollector(mongo);
    const targets = [{ database: "inttest", collection: "wl_sorts" }];
    const fromStore = await collector.collectQueryStats(targets);
    if (hasQueryStatsPlanMetrics(version)) {
      expect(fromStore.size).toBeGreaterThan(0);
    } else {
      // Not "no findings" — "cannot tell". Must yield so the profiler runs.
      expect(fromStore.size).toBe(0);
    }

    const shapes =
      (await collector.collectWorkload(targets)).get(workloadKey("inttest", "wl_sorts")) ?? [];
    const sorting = shapes.filter((shape) => shape.sortedInMemory === true);
    expect(sorting.length).toBeGreaterThan(0);
    // Whichever source answered, it attributed the work.
    expect(sorting.some((shape) => (shape.docsExamined ?? 0) > 0)).toBe(true);
    expect(sorting.some((shape) => shape.equality.includes("status"))).toBe(true);

    await mongo
      .db("inttest")
      .command({ profile: 0 })
      .catch(() => {});
  });
});

// Plans decide what an org may do; nothing here talks to a payment provider,
// because none is wired. What matters is that the limits are enforced by the
// api rather than only drawn in the dashboard — a quota the client checks is
// not a quota.
// The default has to be the same number in two places or the dashboard renders a
// state the engine does not act on: the column, for a row that exists, and this
// read's fallback, for the normal state of a new cluster — no policy row at all,
// because nothing creates one at onboarding (#258).
describe("workload analysis is on before anybody configures anything", () => {
  it("reads as on with no policy row, and stays off once switched off", async () => {
    const id = await bareCluster("Unconfigured Policy");
    const rows = await db.select().from(policies).where(eq(policies.clusterId, id));
    expect(rows).toHaveLength(0);

    const fresh = asRecord(await (await api(`/clusters/${id}/policy`, owner)).json());
    expect(fresh.workloadAnalysis).toBe(true);
    // The create side proposes; it never builds without being asked. That is
    // what makes an on-by-default safe, so it is asserted beside it.
    expect(fresh.instantCreate).toBe(false);
    expect(fresh.autoApplyScore).toBe(null);

    const saved = await api(`/clusters/${id}/policy`, owner, {
      method: "PUT",
      body: JSON.stringify({
        workloadAnalysis: false,
        instantCreate: false,
        observeWindowDays: 30,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: null,
        changeWindowEndHour: null,
      }),
    });
    expect(saved.status).toBe(200);
    // A stored false must survive the read's fallback — otherwise "off" would be
    // unreachable, which is the mirror image of the bug being fixed.
    const after = asRecord(await (await api(`/clusters/${id}/policy`, owner)).json());
    expect(after.workloadAnalysis).toBe(false);
  });
});

describe("plan limits", () => {
  async function setPlan(orgId: string, plan: string): Promise<void> {
    await db.update(organizations).set({ plan }).where(eq(organizations.id, orgId));
  }

  it("refuses a second cluster on FREE with 402, and allows it on PRO", async () => {
    const session = await signUp("plan-clusters");
    createdEmails.push(session.email);
    const orgId = asString(asRecord(await (await api("/org", session)).json()).id);
    createdOrgIds.push(orgId);

    const first = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Plan One", connectionString: MONGO_URL }),
    });
    expect(first.status).toBe(200);
    createdClusterIds.push(asString(asRecord(await first.json()).id));

    const second = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Plan Two", connectionString: MONGO_URL }),
    });
    // 402, not 403: the caller is an owner. "Forbidden" would send them
    // looking for a permissions problem they do not have.
    expect(second.status).toBe(402);
    expect(asString(asRecord(await second.json()).message)).toContain("FREE");

    await setPlan(orgId, "PRO");
    const afterUpgrade = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Plan Three", connectionString: MONGO_URL }),
    });
    expect(afterUpgrade.status).toBe(200);
    createdClusterIds.push(asString(asRecord(await afterUpgrade.json()).id));
  });

  it("gates unattended changes, and never gates turning them off", async () => {
    const session = await signUp("plan-workload");
    createdEmails.push(session.email);
    const orgId = asString(asRecord(await (await api("/org", session)).json()).id);
    createdOrgIds.push(orgId);
    const created = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Plan Workload", connectionString: MONGO_URL }),
    });
    const planClusterId = asString(asRecord(await created.json()).id);
    createdClusterIds.push(planClusterId);

    const policy = (automated: boolean) => ({
      // Free on every plan — seeing what to do is not the paid part.
      workloadAnalysis: true,
      instantCreate: automated,
      observeWindowDays: 30,
      maxCollectionSizeBytes: null,
      autoApplyScore: automated ? 70 : null,
      changeWindowStartHour: null,
      changeWindowEndHour: null,
    });

    const refused = await api(`/clusters/${planClusterId}/policy`, session, {
      method: "PUT",
      body: JSON.stringify(policy(true)),
    });
    expect(refused.status).toBe(402);
    // The refusal must not read as "your recommendations are gated too".
    expect(asString(asRecord(await refused.json()).message)).toContain(
      "approve any of them yourself",
    );

    // Everything else about the policy still saves, index suggestions included.
    expect(
      (
        await api(`/clusters/${planClusterId}/policy`, session, {
          method: "PUT",
          body: JSON.stringify(policy(false)),
        })
      ).status,
    ).toBe(200);

    await setPlan(orgId, "PRO");
    expect(
      (
        await api(`/clusters/${planClusterId}/policy`, session, {
          method: "PUT",
          body: JSON.stringify(policy(true)),
        })
      ).status,
    ).toBe(200);

    // And a downgrade stops the engine acting on what is still stored — the
    // api gate alone would let a saved score keep approving.
    await setPlan(orgId, "FREE");
    const stored = await db
      .select()
      .from(policies)
      .where(eq(policies.clusterId, planClusterId))
      .limit(1);
    expect(stored[0]?.autoApplyScore).toBe(70);
    expect(
      entitledAutomation(
        { autoApplyScore: stored[0]?.autoApplyScore ?? null, instantCreate: true },
        await planForCluster(db, planClusterId),
      ),
    ).toEqual({ autoApplyScore: null, instantCreate: false });
  });

  it("counts an outstanding invite against the seat limit", async () => {
    const session = await signUp("plan-seats");
    createdEmails.push(session.email);
    const orgId = asString(asRecord(await (await api("/org", session)).json()).id);
    createdOrgIds.push(orgId);

    // FREE allows 3 seats and the owner is one, so two invites fit.
    for (const who of ["seat-a", "seat-b"]) {
      const res = await authPost("/organization/invite-member", session, {
        email: `${who}-${Date.now()}@example.test`,
        role: "member",
      });
      expect(res.status).toBe(200);
    }
    const third = await authPost("/organization/invite-member", session, {
      email: `seat-c-${Date.now()}@example.test`,
      role: "member",
    });
    // 402 with our own message, not the plugin's bare 403: the limit is a plan,
    // and every plan refusal here names the limit and what to do about it.
    expect(third.status).toBe(402);
    expect(asString(asRecord(await third.json()).message)).toContain("members");

    // And the org page reports the same number the refusal was based on.
    const org = asRecord(await (await api("/org", session)).json());
    expect(asRecord(org.plan).membersUsed).toBe(3);
    expect(asRecord(org.plan).maxMembers).toBe(3);
  });
});

// Retention is the one entitlement that costs the operator real storage, so it
// has to be enforced rather than advertised. Two orgs on different plans keep
// different amounts of the same kind of row.
describe("retention follows the plan", () => {
  // Retention is two separate things now, and this pins both.
  //
  // DELETION runs one cutoff for the whole deployment — the longest any plan may
  // see — so rows outlive the window a given org is entitled to. VISIBILITY is the
  // per-plan window, applied on every read. That split is what lets an upgrade hand
  // a customer their history back at once instead of making them wait it out.
  it("keeps a downgraded org's rows but stops showing them", async () => {
    const session = await signUp("retention");
    createdEmails.push(session.email);
    const orgId = await giveRoom(session);
    const created = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Retention Cluster", connectionString: MONGO_URL }),
    });
    const retentionClusterId = asString(asRecord(await created.json()).id);
    createdClusterIds.push(retentionClusterId);

    // 120 days old: inside SCALE's year, outside FREE's 90 days.
    const captured = new Date(Date.now() - 120 * 86_400_000);
    await insertLatency(db, [
      {
        clusterId: retentionClusterId,
        database: "retention",
        collection: "aged",
        readOps: 1,
        readLatencyMicros: 1,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: captured,
      },
    ]);

    const visibleCollections = async (): Promise<string[]> => {
      const body = asRecord(
        await (await api(`/clusters/${retentionClusterId}/latency`, session)).json(),
      );
      const rows = Array.isArray(body.collections) ? body.collections.map(asRecord) : [];
      return rows.map((row) => asString(row.collection));
    };

    // On SCALE the row is inside the entitlement, so it is both kept and shown.
    await pruneOldSamples(db);
    expect(
      await db
        .select()
        .from(latencySamples)
        .where(eq(latencySamples.clusterId, retentionClusterId)),
    ).toHaveLength(1);
    expect(await visibleCollections()).toContain("aged");

    // Downgrade. The row is now outside what FREE may see, but well inside the
    // deployment's physical window — so it stays on disk and stops being served.
    await db.update(organizations).set({ plan: "FREE" }).where(eq(organizations.id, orgId));
    await pruneOldSamples(db);
    expect(
      await db
        .select()
        .from(latencySamples)
        .where(eq(latencySamples.clusterId, retentionClusterId)),
    ).toHaveLength(1);
    expect(await visibleCollections()).not.toContain("aged");

    // Upgrading again returns it immediately — the point of keeping it.
    await db.update(organizations).set({ plan: "SCALE" }).where(eq(organizations.id, orgId));
    expect(await visibleCollections()).toContain("aged");
  });

  it("deletes what nobody could ever be entitled to", async () => {
    const session = await signUp("retention-hard");
    createdEmails.push(session.email);
    await giveRoom(session);
    const created = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Hard Retention Cluster", connectionString: MONGO_URL }),
    });
    const hardId = asString(asRecord(await created.json()).id);
    createdClusterIds.push(hardId);

    // Past the longest plan's window, so no plan could show it and nothing keeps it.
    await insertLatency(db, [
      {
        clusterId: hardId,
        database: "retention",
        collection: "ancient",
        readOps: 1,
        readLatencyMicros: 1,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date(Date.now() - 400 * 86_400_000),
      },
    ]);
    await pruneOldSamples(db);
    expect(
      await db.select().from(latencySamples).where(eq(latencySamples.clusterId, hardId)),
    ).toHaveLength(0);
  });

  it("lets the operator cap a plan that would keep more", async () => {
    const session = await signUp("retention-cap");
    createdEmails.push(session.email);
    await giveRoom(session);
    const created = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Capped Cluster", connectionString: MONGO_URL }),
    });
    const cappedClusterId = asString(asRecord(await created.json()).id);
    createdClusterIds.push(cappedClusterId);

    await insertLatency(db, [
      {
        clusterId: cappedClusterId,
        database: "inttest",
        collection: "orders",
        readOps: 1,
        readLatencyMicros: 1,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date(Date.now() - 120 * 86_400_000),
      },
    ]);

    // The ceiling is read from the validated environment, which this process
    // parsed at startup (vitest.integration.setup.ts) — so setting it means
    // saying when the process read it, and putting it back means saying so
    // again.
    const previous = process.env.RETENTION_DAYS;
    process.env.RETENTION_DAYS = "7";
    loadEnv("api");
    try {
      await pruneOldSamples(db);
    } finally {
      if (previous === undefined) delete process.env.RETENTION_DAYS;
      else process.env.RETENTION_DAYS = previous;
      loadEnv("api");
    }
    // SCALE would have kept it for a year; the operator's ceiling wins.
    expect(
      await db.select().from(latencySamples).where(eq(latencySamples.clusterId, cappedClusterId)),
    ).toHaveLength(0);
  });
});

// Narrowing {a,b,c} to {a,b} leans on two things staying true across a classify
// pass: the drop of the long index has to survive, and the new short index must
// not be proposed for a drop of its own while the long one is still there.
// Get either wrong and the two indexes cover each other out of existence, or
// the retirement quietly vanishes and the cluster keeps both forever.
describe("retiring a narrowed index", () => {
  function spec(name: string, fields: string[]) {
    return {
      name,
      keys: fields.map((field) => ({ field, direction: 1 })),
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
  }

  it("keeps the retirement and spares the replacement", async () => {
    const org = asRecord(await (await api("/org", owner)).json());
    const [row] = await db
      .insert(clusters)
      .values({
        orgId: asString(org.id),
        name: "Narrow Cluster",
        sealedDek: Buffer.alloc(1),
        sealedData: Buffer.alloc(1),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("failed to insert cluster");
    const narrowId = row.id;
    createdClusterIds.push(narrowId);

    // Both indexes in use, so neither is a DROP_UNUSED on its own merits — the
    // only finding available is the structural one, which is the point.
    const base = Date.now() - 10 * 86_400_000;
    const since = new Date(base - 86_400_000).toISOString();
    for (const [name, fields] of [
      ["a_1_b_1_c_1", ["a", "b", "c"]],
      ["a_1_b_1", ["a", "b"]],
    ] as const) {
      await insertSnapshots(
        db,
        Array.from({ length: 20 }, (_, i) => ({
          clusterId: narrowId,
          database: "inttest",
          collection: "events",
          indexName: name,
          spec: spec(name, [...fields]),
          sizeBytes: 8192,
          perMember: [{ member: "m1", ops: (i + 1) * 100, since }],
          capturedAt: new Date(base + i * 43_200_000),
        })),
      );
    }
    await insertLatency(
      db,
      Array.from({ length: 20 }, (_, i) => ({
        clusterId: narrowId,
        database: "inttest",
        collection: "events",
        readOps: (i + 1) * 500,
        readLatencyMicros: 100,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date(base + i * 43_200_000),
      })),
    );

    // What finalize.ts files once a narrowing build graduates.
    const [retirement] = await db
      .insert(recommendations)
      .values({
        clusterId: narrowId,
        type: "DROP_REDUNDANT",
        state: "PROPOSED",
        source: "RETIRE",
        database: "inttest",
        collection: "events",
        indexName: "a_1_b_1_c_1",
        rationale: "Superseded by a_1_b_1, which has now survived its post-build watch.",
        score: 55,
        estimatedBytesSaved: 0,
      })
      .returning();
    if (retirement === undefined) throw new Error("failed to insert retirement");

    // Nothing new to find: a_1_b_1 IS a key-prefix of a_1_b_1_c_1, but the
    // longer index is on its way out and cannot justify dropping anything.
    expect(await classifyCluster(db, narrowId)).toBe(0);
    const after = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, narrowId));
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(retirement.id);

    // Someone dropped the long index by hand. The proposal can never be
    // actioned now, so it has to be retracted rather than sit there forever.
    // Deleting the dimension row cascades to its snapshots, which is what a
    // retention sweep eventually does to an index nobody collects any more.
    await db
      .delete(clusterIndexes)
      .where(
        and(eq(clusterIndexes.clusterId, narrowId), eq(clusterIndexes.indexName, "a_1_b_1_c_1")),
      );
    await classifyCluster(db, narrowId);
    expect(
      await db.select().from(recommendations).where(eq(recommendations.clusterId, narrowId)),
    ).toHaveLength(0);
  });
});

// Retention covered the two tables of raw counters and left the two a customer
// actually reads. Adding them raises the question the FK change exists to
// answer: the money this product saved must not leave with the row that
// earned it.
describe("finished decisions age out, the ROI they earned does not", () => {
  it("prunes a settled recommendation and keeps its freed bytes", async () => {
    const session = await signUp("decision-retention");
    createdEmails.push(session.email);
    const orgId = await giveRoom(session);
    const created = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({ name: "Decision Cluster", connectionString: MONGO_URL }),
    });
    const decisionClusterId = asString(asRecord(await created.json()).id);
    createdClusterIds.push(decisionClusterId);
    await db.update(organizations).set({ plan: "FREE" }).where(eq(organizations.id, orgId));

    const old = new Date(Date.now() - 120 * 86_400_000);
    const [settled] = await db
      .insert(recommendations)
      .values({
        clusterId: decisionClusterId,
        type: "DROP_UNUSED",
        state: "DROPPED",
        database: "inttest",
        collection: "orders",
        indexName: "stale_1",
        rationale: "no recorded usage",
        score: 80,
        estimatedBytesSaved: 4096,
        updatedAt: old,
      })
      .returning();
    // Still live, and just as old: an index hidden through a long outage must
    // not be swept out from under its own observe window.
    const [live] = await db
      .insert(recommendations)
      .values({
        clusterId: decisionClusterId,
        type: "DROP_UNUSED",
        state: "HIDDEN",
        database: "inttest",
        collection: "orders",
        indexName: "hidden_1",
        rationale: "no recorded usage",
        score: 80,
        estimatedBytesSaved: 4096,
        updatedAt: old,
      })
      .returning();
    if (settled === undefined || live === undefined) throw new Error("insert failed");

    await db.insert(actions).values({
      recommendationId: settled.id,
      kind: "DROP",
      actor: "system",
      result: "dropped",
      rollbackToken: { spec: { name: "stale_1" } },
    });
    await db.insert(roiMetrics).values({
      clusterId: decisionClusterId,
      recommendationId: settled.id,
      freedBytes: 4096,
      indexCountDelta: 1,
      periodStart: old,
      periodEnd: old,
    });

    await pruneOldSamples(db);

    const left = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, decisionClusterId));
    expect(left.map((row) => row.id)).toEqual([live.id]);
    // The audit trail and its rollback token went with it — undo is not offered
    // past the window, which is what the plan already says.
    expect(
      await db.select().from(actions).where(eq(actions.recommendationId, settled.id)),
    ).toHaveLength(0);
    // But the headline figure is intact, now unattributed.
    const roi = await db
      .select()
      .from(roiMetrics)
      .where(eq(roiMetrics.clusterId, decisionClusterId));
    expect(roi).toHaveLength(1);
    expect(roi[0]?.freedBytes).toBe(4096);
    expect(roi[0]?.recommendationId).toBeNull();
  });
});

// An index optimizer whose own control plane was missing nine of them.
//
// Every one was a foreign key, and an un-indexed foreign key is not a slow
// query — it is a scan of the whole child table for each parent row deleted.
// Retention deletes settled recommendations in bulk, and roi_metrics references
// them: ten thousand rows took 8.4 seconds to remove, of which 5ms was finding
// them. With the index, 594ms.
//
// The test is the rule rather than the nine, because the nine are already
// fixed. What is worth keeping is that the tenth cannot be added quietly.
// The probe compares live latency against "how fast was this collection before",
// and before is the NEWEST stored sample. Picking an older row is the way this
// goes wrong quietly: the comparison is against the wrong baseline and nothing
// about the resulting finding looks unusual. Worth a test of its own because the
// query was rewritten to a `distinct on` — it used to read every row for the
// cluster and choose in JS.
describe("probe baselines", () => {
  it("takes the newest sample per namespace, and only one per namespace", async () => {
    await insertLatency(db, [
      // Two namespaces, three captures each, deliberately inserted out of order.
      {
        clusterId,
        database: "bl",
        collection: "a",
        readOps: 20,
        readLatencyMicros: 200,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date("2026-02-02T00:00:00Z"),
      },
      {
        clusterId,
        database: "bl",
        collection: "a",
        readOps: 30,
        readLatencyMicros: 300,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date("2026-02-03T00:00:00Z"),
      },
      {
        clusterId,
        database: "bl",
        collection: "a",
        readOps: 10,
        readLatencyMicros: 100,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date("2026-02-01T00:00:00Z"),
      },
      {
        clusterId,
        database: "bl",
        collection: "b",
        readOps: 70,
        readLatencyMicros: 700,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date("2026-02-03T00:00:00Z"),
      },
      {
        clusterId,
        database: "bl",
        collection: "b",
        readOps: 90,
        readLatencyMicros: 900,
        writeOps: 0,
        writeLatencyMicros: 0,
        capturedAt: new Date("2026-02-04T00:00:00Z"),
      },
    ]);

    const rows = (await latestBaselines(db, clusterId)).filter((row) => row.database === "bl");

    expect(rows).toHaveLength(2);
    const byNs = new Map(rows.map((row) => [row.collection, row]));
    // The 2026-02-03 row for a, not the 02-01 or 02-02 ones.
    expect(byNs.get("a")?.readOps).toBe(30);
    expect(byNs.get("a")?.readLatencyMicros).toBe(300);
    // And the 02-04 row for b, not the 02-03 one.
    expect(byNs.get("b")?.readOps).toBe(90);
  });
});

// Storage used to grow with the collect cadence rather than with the cluster:
// every look rewrote each index's spec and identity, and rewrote an unchanged
// counter beside them. Two collects in a row is the smallest experiment that
// shows both halves fixed — nothing about the cluster changed between them, so
// nothing new should have been written.
describe("collecting twice writes almost nothing the second time", () => {
  let runClusterId = "";
  let runSession: Session;

  beforeAll(async () => {
    // Its own account, because this one needs a REAL connection and the
    // outbound-dial budget is per user — spending another of owner's would be
    // charged to whichever later scenario happened to run out.
    runSession = await signUp("runlength");
    createdEmails.push(runSession.email);
    await giveRoom(runSession);
    const res = await api("/clusters", runSession, {
      method: "POST",
      body: JSON.stringify({ name: "Run Length Cluster", connectionString: MONGO_URL }),
    });
    expect(res.status).toBe(200);
    runClusterId = asString(asRecord(await res.json()).id);
    createdClusterIds.push(runClusterId);
  });

  it("extends the runs it has instead of inserting a row per index", async () => {
    // Two collects driven from here rather than left to the scheduler: connecting
    // only enqueues a tick, and the suite runs no worker.
    await collectCluster(db, runClusterId);
    const before = await db
      .select({ id: indexSnapshots.id })
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, runClusterId));
    const dimensionsBefore = await db
      .select({ id: clusterIndexes.id })
      .from(clusterIndexes)
      .where(eq(clusterIndexes.clusterId, runClusterId));
    expect(before.length).toBeGreaterThan(0);
    // The first look is a run of one for every index it saw.
    expect(dimensionsBefore.length).toBe(before.length);

    await collectCluster(db, runClusterId);

    const after = await db
      .select()
      .from(indexSnapshots)
      .where(eq(indexSnapshots.clusterId, runClusterId));
    const dimensionsAfter = await db
      .select({ id: clusterIndexes.id })
      .from(clusterIndexes)
      .where(eq(clusterIndexes.clusterId, runClusterId));

    // The spec and the identity are constants of the index, so the second look
    // added no dimension rows at all.
    expect(dimensionsAfter.length).toBe(dimensionsBefore.length);

    // And most indexes went untouched between the two collects, so their rows
    // were extended rather than duplicated. Not all — the control plane is
    // querying this very cluster, so a few counters legitimately moved.
    const extended = after.filter((row) => row.observations > 1);
    expect(extended.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before.length * 2);

    // An extended run keeps the moment the state was FIRST seen and moves only
    // the moment it was last confirmed. Losing captured_at would erase how long
    // the index has been idle, which is most of the evidence behind a drop.
    for (const row of extended) {
      expect(row.lastSeenAt.getTime()).toBeGreaterThan(row.capturedAt.getTime());
      // And it records how wide its own interior grew, so the trust gate can check
      // for a hole inside the run instead of taking the collector's ceiling on
      // faith. Two collects back to back, so the interval is small but real —
      // exactly the span between the two lastSeenAt values.
      expect(row.maxGapMs).toBeGreaterThan(0);
      expect(row.maxGapMs).toBeLessThanOrEqual(row.lastSeenAt.getTime() - row.capturedAt.getTime());
    }
    // A run of one has no interior and must say so, rather than inheriting a
    // neighbour's number.
    for (const row of after.filter((candidate) => candidate.observations === 1)) {
      expect(row.maxGapMs).toBe(0);
    }
  });

  it("still reports an extended index in the collection footprint", async () => {
    // getCollections used to read the newest BATCH of inserts, which an idle
    // index is no longer part of. Every index the last collect saw shares a
    // last_seen_at instead, extended or inserted.
    const res = await api(`/clusters/${runClusterId}/collections`, runSession);
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const collections = Array.isArray(body.collections) ? body.collections : [];
    expect(collections.length).toBeGreaterThan(0);
    const counted = collections
      .map((entry) => asRecord(entry))
      .reduce((sum, entry) => sum + Number(entry.indexCount), 0);
    // As many indexes as the newest collect saw — which, since nothing was
    // dropped between the two, is every index with a dimension row.
    const dimensions = await db
      .select({ id: clusterIndexes.id })
      .from(clusterIndexes)
      .where(eq(clusterIndexes.clusterId, runClusterId));
    expect(counted).toBe(dimensions.length);
  });

  // Extending a run rewrites two columns that are NOT part of what makes the run,
  // and they behave in opposite directions. Both live in the raw UPDATE, so
  // nothing but a test holds them in place.
  it("carries the newest size forward and never forgets a hint sighting", async () => {
    const spec = {
      name: "ride_along_1",
      keys: [{ field: "ride", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    const started = new Date(Date.now() - 3 * 86_400_000);
    await insertSnapshots(db, [
      {
        clusterId: runClusterId,
        database: "ride",
        collection: "along",
        indexName: "ride_along_1",
        spec,
        sizeBytes: 1024,
        perMember: [{ member: "m1", ops: 7 }],
        // Seen being hinted once, three days ago.
        hinted: true,
        capturedAt: started,
        lastSeenAt: started,
        observations: 1,
      },
    ]);
    const [before] = await db
      .select({ id: indexSnapshots.id })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(eq(clusterIndexes.database, "ride"));
    if (before === undefined) throw new Error("fixture row missing");

    // The same counter seen again, on a bigger index, with no hint in this
    // profiler window.
    const now = new Date();
    await db.execute(sql`
      update ${indexSnapshots} as s
      set last_seen_at = ${now},
          observations = s.observations + 1,
          size_bytes = v.size_bytes,
          hinted = s.hinted or v.hinted
      from unnest(${sql.param([before.id])}::uuid[], ${sql.param([9999])}::bigint[], ${sql.param([false])}::boolean[])
        as v(id, size_bytes, hinted)
      where s.id = v.id
    `);

    const [after] = await db.select().from(indexSnapshots).where(eq(indexSnapshots.id, before.id));
    // Size is a ride-along, replaced with the live reading, because every caller
    // wants the current number and nothing reads the size series.
    expect(after?.sizeBytes).toBe(9999);
    // Hint is sticky. One sighting anywhere in the retained history is what stops
    // this index being auto-dropped — hiding a hinted index makes mongod reject
    // those queries outright — so a later quiet collect must not clear it.
    expect(after?.hinted).toBe(true);
    // And the run kept its start while moving only its end.
    expect(after?.capturedAt.getTime()).toBe(started.getTime());
    expect(after?.observations).toBe(2);
  });

  // The invariant every reader leans on, held by the database rather than by the
  // writer's good behaviour. Readers find holes by differencing
  // `previous.last_seen_at → next.captured_at`, so an overlap is a NEGATIVE gap —
  // which reads as no gap at all. Exactly the failure this change was careful
  // about, arriving by the back door.
  it("refuses two runs for one index that overlap in time", async () => {
    const spec = {
      name: "overlap_probe_1",
      keys: [{ field: "overlap", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    const base = Date.now() - 10 * 86_400_000;
    const fixture = (capturedAt: Date, lastSeenAt: Date, ops: number) => ({
      clusterId: runClusterId,
      database: "overlap",
      collection: "probe",
      indexName: "overlap_probe_1",
      spec,
      sizeBytes: 1024,
      perMember: [{ member: "m1", ops }],
      capturedAt,
      lastSeenAt,
      observations: 4,
    });

    // A run covering days 0-3.
    await insertSnapshots(db, [fixture(new Date(base), new Date(base + 3 * 86_400_000), 0)]);
    // A second run starting inside it — a clock that stepped back, or two collects
    // racing. Must not be storable.
    await expect(
      insertSnapshots(db, [
        fixture(new Date(base + 86_400_000), new Date(base + 5 * 86_400_000), 1),
      ]),
    ).rejects.toThrow();
    // And a run that starts after it ends is fine.
    await insertSnapshots(db, [
      fixture(new Date(base + 4 * 86_400_000), new Date(base + 6 * 86_400_000), 1),
    ]);
    const runs = await db
      .select({ id: indexSnapshots.id })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(eq(clusterIndexes.database, "overlap"));
    expect(runs).toHaveLength(2);
  });

  it("keeps a run that is still live and prunes one that ended", async () => {
    // Retention moved to last_seen_at. On captured_at it would have deleted the
    // row an idle index is still living in the moment its START aged out —
    // taking the only evidence that we are watching it, and handing the trust
    // gate a hole where there was none.
    const old = new Date(Date.now() - 400 * 86_400_000);
    const spec = {
      name: "retain_probe_1",
      keys: [{ field: "retain", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    await insertSnapshots(db, [
      // Started over a year ago and confirmed a moment ago: live.
      {
        clusterId: runClusterId,
        database: "retain",
        collection: "live",
        indexName: "retain_probe_1",
        spec,
        sizeBytes: 1024,
        perMember: [{ member: "m1", ops: 0 }],
        capturedAt: old,
        lastSeenAt: new Date(),
        observations: 500,
      },
      // Started and finished over a year ago: history, and prunable.
      {
        clusterId: runClusterId,
        database: "retain",
        collection: "ended",
        indexName: "retain_probe_1",
        spec,
        sizeBytes: 1024,
        perMember: [{ member: "m1", ops: 0 }],
        capturedAt: old,
        lastSeenAt: old,
        observations: 1,
      },
    ]);

    await pruneOldSamples(db);

    const left = await db
      .select({ collection: clusterIndexes.collection })
      .from(indexSnapshots)
      .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
      .where(
        and(eq(indexSnapshots.clusterId, runClusterId), eq(clusterIndexes.database, "retain")),
      );
    expect(left.map((row) => row.collection)).toEqual(["live"]);
  });
});

describe("the control plane's own indexes", () => {
  it("has no foreign key without one", async () => {
    const rows = await db.execute(sql`
      select c.conrelid::regclass::text as child, a.attname as column
      from pg_constraint c
      join unnest(c.conkey) k(attnum) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f'
        and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indkey[0] = a.attnum
        )
    `);
    const unindexed = rows.rows.map((row) => `${String(row.child)}.${String(row.column)}`);
    expect(unindexed).toEqual([]);
  });

  // "One live recommendation per index" was convention until #283 — three guard
  // functions every producer had to remember to call, over a schema that would
  // happily store two. These assert the net underneath them, which is the only
  // part a new producer cannot forget. Written against the constraint rather than
  // through a pass, because the thing under test is the database's answer.
  // The per-collection build budget's database half (#281). The arithmetic and the
  // calibration are unit-tested; what needs a real table is which rows count.
  describe("pending builds per collection", () => {
    let budgetClusterId: string;

    const build = (
      overrides: Partial<typeof recommendations.$inferInsert>,
    ): typeof recommendations.$inferInsert => ({
      clusterId: budgetClusterId,
      type: "CREATE",
      state: "PROPOSED",
      source: "WORKLOAD",
      database: "shop",
      collection: "orders",
      indexName: "fixture_1",
      rationale: "fixture",
      score: 50,
      targetSpec: { keys: ["a"], retire: [] },
      ...overrides,
    });

    beforeAll(async () => {
      const org = asRecord(await (await api("/org", owner)).json());
      const [row] = await db
        .insert(clusters)
        .values({
          orgId: asString(org.id),
          name: "Build Budget Cluster",
          sealedDek: Buffer.alloc(1),
          sealedData: Buffer.alloc(1),
          keyVersion: 1,
        })
        .returning();
      if (row === undefined) throw new Error("failed to insert cluster");
      budgetClusterId = row.id;
      createdClusterIds.push(budgetClusterId);
    });

    afterEach(async () => {
      await db.delete(recommendations).where(eq(recommendations.clusterId, budgetClusterId));
    });

    // Pending is the point. An APPROVED create waits for the change window, which
    // can be most of a day, and its index does not exist yet — so counting only
    // what a collect saw makes five builds approved across five passes each look
    // like the first one.
    it("counts a build in flight, whatever live state it is in", async () => {
      await db
        .insert(recommendations)
        .values([
          build({ indexName: "a_1" }),
          build({ indexName: "b_1", state: "APPROVED" }),
          build({ indexName: "c_1", state: "BUILDING" }),
        ]);
      const counts = await pendingBuildsByCollection(db, budgetClusterId);
      expect(counts.get("shop orders")).toBe(3);
    });

    // A build that retires what it replaces leaves the collection carrying the
    // same number or fewer, so charging it against a budget it is about to
    // relieve would have the engine arguing against its own best move.
    it("does not count a build that retires what it replaces", async () => {
      await db.insert(recommendations).values([
        build({
          indexName: "wide_1",
          type: "UPDATE",
          targetSpec: { keys: ["a"], retire: ["a_1"] },
        }),
        build({
          indexName: "merged_1",
          type: "MERGE",
          targetSpec: { keys: ["a", "b"], retire: ["a_1", "b_1"] },
        }),
      ]);
      expect(
        (await pendingBuildsByCollection(db, budgetClusterId)).get("shop orders"),
      ).toBeUndefined();
    });

    // A settled build is either an index that exists — and so is already in the
    // collect's own count — or one that never will be. Counting it would charge
    // the collection twice for the same index.
    it("does not count a settled build", async () => {
      await db
        .insert(recommendations)
        .values([
          build({ indexName: "done_1", state: "ACTIVE" }),
          build({ indexName: "no_1", state: "REJECTED" }),
        ]);
      expect(
        (await pendingBuildsByCollection(db, budgetClusterId)).get("shop orders"),
      ).toBeUndefined();
    });

    // The budget is per collection, which is the whole of #281: the guards are
    // keyed on an index and the cost is paid per collection.
    it("keeps collections apart", async () => {
      await db
        .insert(recommendations)
        .values([
          build({ indexName: "a_1" }),
          build({ indexName: "b_1", collection: "customers" }),
        ]);
      const counts = await pendingBuildsByCollection(db, budgetClusterId);
      expect(counts.get("shop orders")).toBe(1);
      expect(counts.get("shop customers")).toBe(1);
    });
  });

  describe("one live claim per index", () => {
    let claimClusterId: string;

    // Rows go in by hand: the point is what the schema refuses, and driving a
    // pass would test the guards that are supposed to keep us away from it.
    const live = (
      overrides: Partial<typeof recommendations.$inferInsert>,
    ): typeof recommendations.$inferInsert => ({
      clusterId: claimClusterId,
      type: "DROP_UNUSED",
      state: "PROPOSED",
      source: "CLASSIFY",
      database: "shop",
      collection: "orders",
      indexName: "status_1",
      rationale: "fixture",
      score: 10,
      ...overrides,
    });

    const insert = (values: typeof recommendations.$inferInsert): Promise<unknown> =>
      db.insert(recommendations).values(values);

    beforeAll(async () => {
      const org = asRecord(await (await api("/org", owner)).json());
      const [row] = await db
        .insert(clusters)
        .values({
          orgId: asString(org.id),
          name: "One Live Claim Cluster",
          sealedDek: Buffer.alloc(1),
          sealedData: Buffer.alloc(1),
          keyVersion: 1,
        })
        .returning();
      if (row === undefined) throw new Error("failed to insert cluster");
      claimClusterId = row.id;
      createdClusterIds.push(claimClusterId);
    });

    afterEach(async () => {
      await db.delete(recommendations).where(eq(recommendations.clusterId, claimClusterId));
    });

    // The duplicate the three guards exist to prevent, and the one a fourth
    // producer that forgets one of them would create.
    it("refuses a second live row making the same claim", async () => {
      await insert(live({}));
      await expect(insert(live({ source: "WORKLOAD" }))).rejects.toThrow();
    });

    // The part a constraint keyed on `type` would have got wrong: both of these
    // mean "this index should go", so holding one of each is the same duplicate
    // arriving by two routes.
    it("refuses DROP_REDUNDANT beside DROP_UNUSED", async () => {
      await insert(live({ type: "DROP_UNUSED" }));
      await expect(insert(live({ type: "DROP_REDUNDANT", source: "RETIRE" }))).rejects.toThrow();
    });

    // A drop and a build are different claims about one NAME, and both are
    // legitimate at once: narrowing an index means building the shorter one
    // while the longer is still on its way out.
    it("allows a build beside a drop on the same index", async () => {
      await insert(live({ type: "DROP_UNUSED" }));
      await insert(
        live({ type: "CREATE", source: "WORKLOAD", targetSpec: { keys: [], retire: [] } }),
      );
      const rows = await db
        .select({ type: recommendations.type })
        .from(recommendations)
        .where(eq(recommendations.clusterId, claimClusterId));
      expect(rows.map((row) => row.type).sort()).toEqual(["CREATE", "DROP_UNUSED"]);
    });

    // A settled row is history. classify is supposed to be able to propose
    // dropping an index a graduated build put there, so the predicate has to let
    // the next claim through — otherwise this index would freeze the engine out
    // of every index it ever touched.
    it("allows a new claim once the previous one settled", async () => {
      await insert(live({ state: "DROPPED" }));
      await insert(live({ state: "REJECTED" }));
      await insert(live({}));
      const rows = await db
        .select({ state: recommendations.state })
        .from(recommendations)
        .where(eq(recommendations.clusterId, claimClusterId));
      expect(rows.map((row) => row.state).sort()).toEqual(["DROPPED", "PROPOSED", "REJECTED"]);
    });

    // Advisories are out on purpose: classify already exempts them from the
    // standing check by hand, and two different things worth telling a human
    // about one index are both worth saying.
    it("does not constrain advisories", async () => {
      await insert(live({ type: "ADVISORY_REVIEW", rationale: "hinted but unused" }));
      await insert(live({ type: "ADVISORY_REVIEW", rationale: "a second index on the same keys" }));
      const rows = await db
        .select({ rationale: recommendations.rationale })
        .from(recommendations)
        .where(eq(recommendations.clusterId, claimClusterId));
      expect(rows).toHaveLength(2);
    });

    // What the producers do with the refusal. A losing race must be a no-op
    // rather than a thrown pass — the other producer said the same thing first,
    // which is the outcome either way.
    it("makes a losing insert a no-op for the producers", async () => {
      await insert(live({}));
      await db
        .insert(recommendations)
        .values(live({ source: "WORKLOAD" }))
        .onConflictDoNothing();
      const rows = await db
        .select({ source: recommendations.source })
        .from(recommendations)
        .where(eq(recommendations.clusterId, claimClusterId));
      expect(rows.map((row) => row.source)).toEqual(["CLASSIFY"]);
    });
  });
});

// The owner second-factor posture (#55) is an env flag, so it gets its own api
// instance — the main one stays open so every other scenario works without
// enrolling an authenticator. The suite plays the authenticator app itself
// (integration/totp.ts): the code paths exercised are the ones a phone drives.
describe("owner two-factor requirement (second api with REQUIRE_OWNER_2FA)", () => {
  const PORT = 3097;
  const BASE = `http://localhost:${PORT}`;
  let gated: ChildProcess;
  let gatedOwner: Session;

  async function gatedSignUp(prefix: string): Promise<Session> {
    const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@int.test`;
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password: "password12345", name: prefix }),
    });
    expect(res.status).toBe(200);
    createdEmails.push(email);
    return sessionFrom(email, res);
  }

  beforeAll(async () => {
    // SMTP is cleared deliberately, and it is load-bearing twice over. It puts
    // this instance in the state a fresh self-hosted install is in, which is
    // what the emailed-code refusal below is about — and it stops the suite
    // handing real messages to whatever SMTP account the developer's .env
    // happens to name, which is what a send-otp test does otherwise.
    gated = await startApi(
      { REQUIRE_OWNER_2FA: "true", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" },
      PORT,
    );
    gatedOwner = await gatedSignUp("twofactor-owner");
    createdOrgIds.push(await createOrg(gatedOwner, "Gated Org", BASE));
  });

  afterAll(async () => {
    await stopApi(gated);
  });

  it("refuses owner acts until a code verifies, then stands aside", async () => {
    // The api's own mutations answer with the code the dashboard keys off.
    const before = await api(
      "/clusters",
      gatedOwner,
      { method: "POST", body: JSON.stringify({ name: "Gated", connectionString: MONGO_URL }) },
      `${BASE}/api`,
    );
    expect(before.status).toBe(403);
    expect(asRecord(await before.json()).code).toBe("TWO_FACTOR_REQUIRED");

    // The org-membership half rides better-auth's routes, not the api's, and
    // gets the same refusal from the hooks.before gate.
    const inviteBefore = await authPost(
      "/organization/invite-member",
      gatedOwner,
      { email: `nobody-${Date.now()}@int.test`, role: "member" },
      BASE,
    );
    expect(inviteBefore.status).toBe(403);
    expect(asRecord(await inviteBefore.json()).code).toBe("TWO_FACTOR_REQUIRED");

    // Enrolment is never gated — it is the way out. Nothing is on until the
    // first code verifies.
    const enable = await authPost(
      "/two-factor/enable",
      gatedOwner,
      { password: "password12345" },
      BASE,
    );
    expect(enable.status).toBe(200);
    const secret = secretFromTotpUri(asString(asRecord(await enable.json()).totpURI));
    const stillGated = await api(
      "/clusters",
      gatedOwner,
      { method: "POST", body: JSON.stringify({ name: "Gated", connectionString: MONGO_URL }) },
      `${BASE}/api`,
    );
    expect(stillGated.status).toBe(403);

    const verify = await authPost(
      "/two-factor/verify-totp",
      gatedOwner,
      { code: totpCode(secret) },
      BASE,
    );
    expect(verify.status).toBe(200);

    // The verify response expired the cookie cache (auth.config.ts hooks.after),
    // so this read comes from the row that now says enabled — without that, the
    // cached false would keep refusing for the cache's maxAge.
    const after = await api(
      "/clusters",
      gatedOwner,
      { method: "POST", body: JSON.stringify({ name: "Gated", connectionString: MONGO_URL }) },
      `${BASE}/api`,
    );
    expect(after.status).toBe(200);
    createdClusterIds.push(asString(asRecord(await after.json()).id));

    const inviteAfter = await authPost(
      "/organization/invite-member",
      gatedOwner,
      { email: `nobody-${Date.now()}@int.test`, role: "member" },
      BASE,
    );
    expect(inviteAfter.status).toBe(200);
  });

  // The emailed code is offered only where mail can actually be sent. This
  // suite runs without SMTP — the same state a fresh self-hosted install is in
  // — so the refusal is the behaviour under test, and it has to be a refusal
  // rather than a 200 with nothing delivered.
  it("refuses to mail a sign-in code when the deployment has no SMTP", async () => {
    const res = await authPost("/two-factor/send-otp", gatedOwner, {}, BASE);
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("EMAIL_NOT_CONFIGURED");
    // And it says what to reach for instead, since the fix is the operator's.
    expect(body).toContain("authenticator app");
  });

  it("exempts an account with no password to pair a code with", async () => {
    const oauthish = await gatedSignUp("twofactor-github");
    createdOrgIds.push(await createOrg(oauthish, "OAuth Org", BASE));

    // Turn the credential account into what a GitHub sign-in leaves behind.
    // The session survives — provider is a fact about the account row, and the
    // gate reads that row live rather than trusting the cookie.
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, oauthish.email));
    await db
      .update(account)
      .set({ providerId: "github" })
      .where(eq(account.userId, asString(row?.id)));

    const res = await api(
      "/clusters",
      oauthish,
      {
        method: "POST",
        body: JSON.stringify({ name: "OAuth Gated", connectionString: MONGO_URL }),
      },
      `${BASE}/api`,
    );
    expect(res.status).toBe(200);
    createdClusterIds.push(asString(asRecord(await res.json()).id));
  });

  it("asks for the code at sign-in once it is on, and a backup code works once", async () => {
    const enrolled = await gatedSignUp("twofactor-signin");
    const enable = await authPost(
      "/two-factor/enable",
      enrolled,
      { password: "password12345" },
      BASE,
    );
    const enabled = asRecord(await enable.json());
    const secret = secretFromTotpUri(asString(enabled.totpURI));
    const codes = asStrings(enabled.backupCodes, "enabled.backupCodes");
    await authPost("/two-factor/verify-totp", enrolled, { code: totpCode(secret) }, BASE);

    // The password alone no longer signs in: better-auth answers a redirect
    // marker and a short-lived 2FA cookie instead of a session.
    const half = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: enrolled.email, password: "password12345" }),
    });
    expect(half.status).toBe(200);
    expect(asRecord(await half.json()).twoFactorRedirect).toBe(true);
    const pending = sessionFrom(enrolled.email, half);

    // No session yet: the data routes refuse the half-signed-in cookie.
    const refused = await api("/orgs", pending, undefined, `${BASE}/api`);
    expect(refused.status).toBe(401);

    const backup = await authPost(
      "/two-factor/verify-backup-code",
      pending,
      { code: codes[0] },
      BASE,
    );
    expect(backup.status).toBe(200);
    const readable = await api("/orgs", pending, undefined, `${BASE}/api`);
    expect(readable.status).toBe(200);

    // Once. A backup code that keeps working is a second password.
    const again = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email: enrolled.email, password: "password12345" }),
    });
    const pendingAgain = sessionFrom(enrolled.email, again);
    const reused = await authPost(
      "/two-factor/verify-backup-code",
      pendingAgain,
      { code: codes[0] },
      BASE,
    );
    expect(reused.status).not.toBe(200);
  });
});

// #161. `per_member` was collected on every member and summed by every reader
// before it reached a screen, so the whole point of collecting per member went
// on making the total honest.
describe("per-node index usage reaches the reader", () => {
  it("carries the split beside the rows, from the last collect's batch", async () => {
    const splitId = await bareCluster("Per Node Usage");
    const now = Date.now();
    const spec = { key: { a: 1 } };
    await insertSnapshots(db, [
      // An older run, deliberately: the reading must come from the newest batch,
      // not from whichever row postgres reaches first.
      {
        clusterId: splitId,
        database: "app",
        collection: "orders",
        indexName: "reporting_1",
        spec,
        sizeBytes: 4_096,
        perMember: [{ member: "a:27017", ops: 5 }],
        capturedAt: new Date(now - 7_200_000),
        lastSeenAt: new Date(now - 7_200_000),
      },
      // All of it on one secondary — the reporting replica case.
      {
        clusterId: splitId,
        database: "app",
        collection: "orders",
        indexName: "reporting_1",
        spec,
        sizeBytes: 4_096,
        perMember: [
          { member: "a:27017", ops: 0 },
          { member: "b:27017", ops: 40_000 },
        ],
        capturedAt: new Date(now - 600_000),
        lastSeenAt: new Date(now),
      },
      // The same total, spread — indistinguishable before this shipped.
      {
        clusterId: splitId,
        database: "app",
        collection: "orders",
        indexName: "spread_1",
        spec,
        sizeBytes: 4_096,
        perMember: [
          { member: "a:27017", ops: 20_000 },
          { member: "b:27017", ops: 20_000 },
        ],
        capturedAt: new Date(now - 600_000),
        lastSeenAt: new Date(now),
      },
    ]);
    await db.insert(recommendations).values([
      {
        clusterId: splitId,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "app",
        collection: "orders",
        indexName: "reporting_1",
        rationale: "no reads on the primary",
        score: 60,
        estimatedBytesSaved: 4_096,
      },
      {
        clusterId: splitId,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "app",
        collection: "orders",
        indexName: "spread_1",
        rationale: "low reads",
        score: 50,
        estimatedBytesSaved: 4_096,
      },
      // No snapshot at all: the last collect did not see it, so it gets no
      // usage entry rather than a row of zeroes.
      {
        clusterId: splitId,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "app",
        collection: "orders",
        indexName: "vanished_1",
        rationale: "gone since the last collect",
        score: 40,
        estimatedBytesSaved: 4_096,
      },
    ]);

    const body = asRecord(await (await api(`/clusters/${splitId}/recommendations`, owner)).json());
    const rows = asRecords(body.recommendations, "body.recommendations");
    const usage = asRecords(body.usage, "body.usage");
    const idOf = (name: string) => rows.find((row) => row.indexName === name)?.id;
    const usageOf = (name: string) => usage.find((entry) => entry.recommendationId === idOf(name));

    // Same total, different objects — which is the whole of the issue.
    expect(usageOf("reporting_1")?.totalOps).toBe(40_000);
    expect(usageOf("spread_1")?.totalOps).toBe(40_000);
    // Busiest first, so concentration is visible without sorting on the client.
    expect(usageOf("reporting_1")?.perMember).toEqual([
      { member: "b:27017", ops: 40_000 },
      { member: "a:27017", ops: 0 },
    ]);
    expect(usageOf("spread_1")?.perMember).toHaveLength(2);
    // The older run's 5 ops on one member is not what came back.
    expect(usageOf("reporting_1")?.perMember).toHaveLength(2);
    // No reading rather than an invented zero.
    expect(usageOf("vanished_1")).toBeUndefined();

    // Another tenant gets the empty shape, usage included.
    const stranger = await signUp("per-node-stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const foreign = asRecord(
      await (await api(`/clusters/${splitId}/recommendations`, stranger)).json(),
    );
    expect(foreign.usage).toEqual([]);
    expect(foreign.recommendations).toEqual([]);
  });
});

// The bounds #64 measured its way to. Both caps are asserted against real
// rows through the real handler, because the whole point of the issue was that
// nobody had measured what the reads actually ship.
describe("bounded per-cluster reads", () => {
  it("sends the highest-scoring recommendations and the true total", async () => {
    const boundedId = await bareCluster("Bounded Recs");
    const OVERSHOOT = 20;
    const rows = [];
    for (let i = 0; i < RECOMMENDATIONS_CAP + OVERSHOOT; i++) {
      rows.push({
        clusterId: boundedId,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "app",
        collection: `coll_${i % 10}`,
        indexName: `idx_${i}_1`,
        rationale: "unused across the trust window",
        // The overshoot scores zero, so "kept the top" is checkable rather
        // than merely "kept some".
        score: i < OVERSHOOT ? 0 : 50,
        estimatedBytesSaved: 1_000,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(recommendations).values(rows.slice(i, i + 500));
    }

    const body = asRecord(
      await (await api(`/clusters/${boundedId}/recommendations`, owner)).json(),
    );
    const sent = asRecords(body.recommendations, "body.recommendations");
    expect(body.total).toBe(RECOMMENDATIONS_CAP + OVERSHOOT);
    expect(sent).toHaveLength(RECOMMENDATIONS_CAP);
    // The cut is by score, not by whatever order postgres felt like.
    expect(sent.every((rec) => rec.score === 50)).toBe(true);
  });

  it("windows the latency series in time and caps the collections it charts", async () => {
    const seriesId = await bareCluster("Bounded Series");
    const now = Date.now();
    const fixtures = [];
    // Enough collections to exceed the cap, with the first ones carrying more
    // readings so the top-N is decided by evidence rather than by luck. Every
    // one of them is READ-ONLY — its write counter never moves — which is the
    // ordinary shape of a busy cluster and the one that broke the cut.
    for (let c = 0; c < LATENCY_SERIES_MAX_COLLECTIONS + 3; c++) {
      const looks = c < LATENCY_SERIES_MAX_COLLECTIONS ? 5 : 3;
      for (let t = 0; t < looks; t++) {
        const at = new Date(now - (looks - t) * 3_600_000);
        fixtures.push({
          clusterId: seriesId,
          database: "app",
          collection: `in_window_${c}`,
          readOps: 100 * (t + 1),
          readLatencyMicros: 1_000 * (t + 1),
          writeOps: 50,
          writeLatencyMicros: 500,
          capturedAt: at,
          lastSeenAt: at,
        });
      }
    }
    // The only collection on the cluster anyone WRITES to, and deliberately the
    // one with the least to show for itself: three readings against the leaders'
    // five. A cut ranked once by total point count drops it, and the write chart
    // then reports the cut's blind spot as an absence of writes.
    for (let t = 0; t < 3; t++) {
      const at = new Date(now - (3 - t) * 3_600_000);
      fixtures.push({
        clusterId: seriesId,
        database: "app",
        collection: "written_to",
        readOps: 10,
        readLatencyMicros: 100,
        writeOps: 50 * (t + 1),
        writeLatencyMicros: 500 * (t + 1),
        capturedAt: at,
        lastSeenAt: at,
      });
    }
    // Inside the plan's 90-day history, outside the series' 30-day window —
    // the case the new floor exists for.
    for (let t = 0; t < 5; t++) {
      const at = new Date(now - (LATENCY_SERIES_WINDOW_DAYS + 30) * 86_400_000 + t * 3_600_000);
      fixtures.push({
        clusterId: seriesId,
        database: "app",
        collection: "ancient",
        readOps: 100 * (t + 1),
        readLatencyMicros: 1_000 * (t + 1),
        writeOps: 50 * (t + 1),
        writeLatencyMicros: 500 * (t + 1),
        capturedAt: at,
        lastSeenAt: at,
      });
    }
    await insertLatency(db, fixtures);

    const body = asRecord(await (await api(`/clusters/${seriesId}/latency-series`, owner)).json());
    const collections = asRecords(body.collections, "body.collections");
    // The denominator counts what had readings IN the window, so the panel can
    // say how many it is not drawing.
    expect(body.totalCollections).toBe(LATENCY_SERIES_MAX_COLLECTIONS + 4);
    expect(collections).toHaveLength(LATENCY_SERIES_MAX_COLLECTIONS);
    expect(collections.map((entry) => entry.collection)).not.toContain("ancient");
    // Half the budget is the write chart's, so the one collection that can fill
    // it survives eight better-evidenced readers.
    expect(collections.map((entry) => entry.collection)).toContain("written_to");

    // The long-term view is still whole: the before/after table reads the same
    // rows without the series' tighter window.
    const summary = asRecord(await (await api(`/clusters/${seriesId}/latency`, owner)).json());
    const summarized = asRecords(summary.collections, "summary.collections");
    expect(summarized.map((entry) => entry.collection)).toContain("ancient");
  });

  // #160. The footprint history was stored and only its newest value was drawn.
  //
  // Buckets are found by containment rather than by index, so this does not
  // depend on the database's timezone: the bucket holding an instant is the last
  // one that starts at or before it.
  it("buckets the index footprint by day, and a day nobody collected is a gap", async () => {
    const sizeId = await bareCluster("Footprint Trend");
    const now = Date.now();
    const DAY = 86_400_000;
    const at = (daysAgo: number, hour: number) => new Date(now - daysAgo * DAY + hour * 3_600_000);
    const spec = { key: { a: 1 } };
    // Runs, not readings: an index that has not changed extends the row it has,
    // so each of these stands for however many collects saw the same counters.
    await insertSnapshots(db, [
      // Four days ago, both indexes seen.
      {
        clusterId: sizeId,
        database: "app",
        collection: "orders",
        indexName: "a_1",
        spec,
        sizeBytes: 1_000,
        perMember: [],
        capturedAt: at(4, -6),
        lastSeenAt: at(4, -1),
      },
      {
        clusterId: sizeId,
        database: "app",
        collection: "orders",
        indexName: "b_1",
        spec,
        sizeBytes: 500,
        perMember: [],
        capturedAt: at(4, -6),
        lastSeenAt: at(4, -1),
      },
      // Two days ago, only one of them — the other was dropped, and the total
      // has to fall rather than carry the missing index forward.
      {
        clusterId: sizeId,
        database: "app",
        collection: "orders",
        indexName: "a_1",
        spec,
        sizeBytes: 2_000,
        perMember: [],
        capturedAt: at(2, -6),
        lastSeenAt: at(2, -1),
      },
      // And now, both again and bigger.
      {
        clusterId: sizeId,
        database: "app",
        collection: "orders",
        indexName: "a_1",
        spec,
        sizeBytes: 3_000,
        perMember: [],
        capturedAt: new Date(now - 600_000),
        lastSeenAt: new Date(now),
      },
      {
        clusterId: sizeId,
        database: "app",
        collection: "orders",
        indexName: "b_1",
        spec,
        sizeBytes: 700,
        perMember: [],
        capturedAt: new Date(now - 600_000),
        lastSeenAt: new Date(now),
      },
      // Inside the plan's 90-day history and outside the trend window, so it
      // must not become the series' first point.
      {
        clusterId: sizeId,
        database: "app",
        collection: "orders",
        indexName: "a_1",
        spec,
        sizeBytes: 99_000,
        perMember: [],
        capturedAt: at(LATENCY_SERIES_WINDOW_DAYS + 20, 0),
        lastSeenAt: at(LATENCY_SERIES_WINDOW_DAYS + 20, 1),
      },
    ]);

    const body = asRecord(await (await api(`/clusters/${sizeId}/index-size-series`, owner)).json());
    const points = asRecords(body.points, "body.points");
    const bucketOf = (when: Date) =>
      points.filter((point) => new Date(String(point.day)).getTime() <= when.getTime()).at(-1);
    const indexOf = (when: Date) =>
      points.findLastIndex((point) => new Date(String(point.day)).getTime() <= when.getTime());

    // Both indexes, summed, at the size the newest run of that day reported.
    expect(bucketOf(at(4, -1))).toMatchObject({ totalBytes: 1_500, indexCount: 2 });
    // One index left: the sum falls, and the count says which kind of fall it is.
    expect(bucketOf(at(2, -1))).toMatchObject({ totalBytes: 2_000, indexCount: 1 });
    expect(bucketOf(new Date(now))).toMatchObject({ totalBytes: 3_700, indexCount: 2 });

    // The day between them is a gap, not a zero and not a straight line: no run
    // overlapped it, so nothing is known about the footprint that day.
    const between = points.slice(indexOf(at(4, -1)) + 1, indexOf(at(2, -1)));
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((point) => point.totalBytes === null && point.indexCount === 0)).toBe(
      true,
    );

    // The summary reads the DRAWABLE ends. The trailing point is today's, and
    // the leading one is four days ago — not the 99 KB run outside the window,
    // and not a null.
    expect(body.firstBytes).toBe(1_500);
    expect(body.latestBytes).toBe(3_700);
    expect(body.changeBytes).toBe(2_200);
    // Bucketed server-side: one point per day of the window, not one per run.
    expect(points.length).toBeLessThanOrEqual(LATENCY_SERIES_WINDOW_DAYS + 1);

    // Another tenant gets the empty shape rather than a refusal, like the other
    // per-cluster reads.
    const stranger = await signUp("footprint-stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const foreign = asRecord(
      await (await api(`/clusters/${sizeId}/index-size-series`, stranger)).json(),
    );
    expect(foreign.points).toEqual([]);
    expect(foreign.latestBytes).toBeNull();
    expect(foreign.changeBytes).toBeNull();
  });

  // #431. Every one of these numbers was already stored and none of them had
  // anywhere to be looked at: index-level readings reached the dashboard only as
  // `IndexUsage`, keyed by recommendationId, so an index nobody had proposed
  // anything about was invisible along with the judgement that it was fine.
  it("lists every index the last collect saw, paged by namespace", async () => {
    const invId = await bareCluster("Index Inventory");
    const now = Date.now();
    const collectedAt = new Date(now);
    const specOf = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      keys: [{ field: "status", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
      ...extra,
    });
    // Three namespaces so the sort and the filter have something to be wrong
    // about, and a deliberately unsorted insert order.
    await insertSnapshots(db, [
      {
        clusterId: invId,
        database: "app",
        collection: "orders",
        indexName: "status_1",
        spec: specOf("status_1"),
        sizeBytes: 4_096,
        perMember: [
          { member: "a:27017", ops: 40, since: new Date(now - 86_400_000).toISOString() },
          { member: "b:27017", ops: 2, since: new Date(now - 86_400_000).toISOString() },
        ],
        capturedAt: new Date(now - 7_200_000),
        lastSeenAt: collectedAt,
      },
      {
        clusterId: invId,
        database: "app",
        collection: "orders",
        indexName: "hidden_1",
        spec: specOf("hidden_1", { hidden: true, unique: true }),
        sizeBytes: 1_024,
        perMember: [],
        hinted: true,
        capturedAt: new Date(now - 7_200_000),
        lastSeenAt: collectedAt,
      },
      {
        clusterId: invId,
        database: "app",
        collection: "carts",
        indexName: "user_1",
        spec: specOf("user_1"),
        sizeBytes: 512,
        perMember: [{ member: "a:27017", ops: 9, since: new Date(now - 3_600_000).toISOString() }],
        capturedAt: new Date(now - 7_200_000),
        lastSeenAt: collectedAt,
      },
      // A run that ENDED before the latest collect: the index was rebuilt or
      // dropped, and the inventory is about what the cluster has now.
      {
        clusterId: invId,
        database: "app",
        collection: "orders",
        indexName: "gone_1",
        spec: specOf("gone_1"),
        sizeBytes: 8_192,
        perMember: [],
        capturedAt: new Date(now - 172_800_000),
        lastSeenAt: new Date(now - 86_400_000),
      },
    ]);

    const body = asRecord(await (await api(`/clusters/${invId}/indexes`, owner)).json());
    const rows = asRecords(body.indexes, "body.indexes");
    // Namespace order, and the retired index is not in it.
    expect(rows.map((row) => `${row.collection}.${row.indexName}`)).toEqual([
      "carts.user_1",
      "orders.hidden_1",
      "orders.status_1",
    ]);
    expect(body.total).toBe(3);
    expect(body.collectedAt).not.toBeNull();
    // Three rows and three matches, so this page IS the set — which the control
    // reads off `total` against the page it was served rather than being told.
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(CLUSTER_INDEXES_PAGE);

    const status = rows.find((row) => row.indexName === "status_1");
    expect(status).toBeDefined();
    // Summed over the members that ANSWERED, with the split beside it: the whole
    // point of D66 is that these two are not the same fact.
    expect(status?.totalOps).toBe(42);
    expect(asRecords(status?.perMember, "perMember").map((entry) => entry.ops)).toEqual([40, 2]);
    // The counter start travels with the count, so a restart is not read as
    // idleness (D114).
    expect(asRecords(status?.perMember, "perMember")[0]?.since).not.toBeNull();
    expect(status?.sizeBytes).toBe(4_096);

    // Two states the customer could previously only infer from a
    // recommendation's ABSENCE.
    const hidden = rows.find((row) => row.indexName === "hidden_1");
    expect(hidden).toMatchObject({ hidden: true, unique: true, hinted: true });
    // A member that did not report this index is not invented as a zero.
    expect(hidden?.perMember).toEqual([]);
    expect(hidden?.totalOps).toBe(0);

    // Namespace-scoped, and the total narrows with it rather than describing
    // rows the reader did not ask for.
    const scoped = asRecord(
      await (await api(`/clusters/${invId}/indexes?collection=carts`, owner)).json(),
    );
    expect(asRecords(scoped.indexes, "scoped.indexes").map((row) => row.indexName)).toEqual([
      "user_1",
    ]);
    expect(scoped.total).toBe(1);

    // A recommendation pointing at an index shows up on that index's row —
    // including one that RETIRES it under a different proposed name, which is
    // what a REORDER is.
    const [dropRow] = await db
      .insert(recommendations)
      .values({
        clusterId: invId,
        type: "DROP_UNUSED",
        state: "PROPOSED",
        database: "app",
        collection: "orders",
        indexName: "status_1",
        rationale: "unused",
      })
      .returning();
    await db.insert(recommendations).values({
      clusterId: invId,
      type: "REORDER",
      state: "PROPOSED",
      database: "app",
      collection: "carts",
      indexName: "user_-1",
      rationale: "wrong direction",
      targetSpec: { keys: ["user:-1"], retire: ["user_1"] },
    });
    const linked = asRecords(
      asRecord(await (await api(`/clusters/${invId}/indexes`, owner)).json()).indexes,
      "linked.indexes",
    );
    expect(asRecord(linked.find((row) => row.indexName === "status_1")?.recommendation).id).toBe(
      dropRow?.id,
    );
    expect(asRecord(linked.find((row) => row.indexName === "user_1")?.recommendation).type).toBe(
      "REORDER",
    );
    // And most indexes have none, which is the population this page exists for.
    expect(linked.find((row) => row.indexName === "hidden_1")?.recommendation).toBeNull();

    // Another tenant gets the empty shape rather than a refusal, like every
    // other per-cluster read.
    const stranger = await signUp("inventory-stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const foreign = asRecord(await (await api(`/clusters/${invId}/indexes`, stranger)).json());
    expect(foreign.indexes).toEqual([]);
    expect(foreign.total).toBe(0);
    expect(foreign.collectedAt).toBeNull();
  });

  // Paging is the whole reason this endpoint is not the uncapped read
  // `getCollections` is: an index list grows with the customer's schema forever.
  // By OFFSET since #445, so the reader gets page numbers rather than a More
  // button they have to keep clicking (D133).
  it("pages the inventory by offset, and clamps past the end", async () => {
    const pagedId = await bareCluster("Index Inventory Paging");
    const now = Date.now();
    const spec = {
      name: "k",
      keys: [{ field: "k", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
      collation: null,
    };
    const count = CLUSTER_INDEXES_PAGE + 7;
    await insertSnapshots(
      db,
      Array.from({ length: count }, (_, n) => ({
        clusterId: pagedId,
        database: "app",
        collection: "wide",
        // Zero-padded so lexicographic order — which is what the ORDER BY uses,
        // and what offset paging slices — is also the order a reader expects.
        indexName: `idx_${String(n).padStart(4, "0")}`,
        spec: { ...spec, name: `idx_${String(n).padStart(4, "0")}` },
        sizeBytes: 100 + n,
        perMember: [],
        capturedAt: new Date(now - 3_600_000),
        lastSeenAt: new Date(now),
      })),
    );

    const first = asRecord(await (await api(`/clusters/${pagedId}/indexes`, owner)).json());
    const firstRows = asRecords(first.indexes, "first.indexes");
    expect(firstRows).toHaveLength(CLUSTER_INDEXES_PAGE);
    // The honest denominator: this is a page of a larger set and says so. Since
    // #445 it is also the row count the control counts pages from, so it is
    // load-bearing rather than only wording.
    expect(first.total).toBe(count);
    // The page it served, echoed. A caller that sent neither gets the api's own
    // answer for both rather than having to assume it.
    expect(first.offset).toBe(0);
    expect(first.limit).toBe(CLUSTER_INDEXES_PAGE);

    const second = asRecord(
      await (
        await api(`/clusters/${pagedId}/indexes?offset=${CLUSTER_INDEXES_PAGE}`, owner)
      ).json(),
    );
    const secondRows = asRecords(second.indexes, "second.indexes");
    expect(secondRows).toHaveLength(count - CLUSTER_INDEXES_PAGE);
    expect(second.offset).toBe(CLUSTER_INDEXES_PAGE);

    // Every index exactly once across the two pages. Offset paging gives this up
    // only when the set MOVES mid-read (D133); nothing collects here between the
    // two requests, so the property holds and is worth pinning.
    const seen = [...firstRows, ...secondRows].map((row) => String(row.indexName));
    expect(new Set(seen).size).toBe(count);

    // A page size the reader chose, and the page numbering that follows from it.
    const sized = asRecord(
      await (await api(`/clusters/${pagedId}/indexes?offset=25&limit=25`, owner)).json(),
    );
    expect(asRecords(sized.indexes, "sized.indexes")).toHaveLength(25);
    expect(sized.limit).toBe(25);
    expect(sized.offset).toBe(25);
    expect(asRecord(asRecords(sized.indexes, "sized.indexes")[0] ?? {}).indexName).toBe(
      String(asRecord(firstRows[25] ?? {}).indexName),
    );

    // Past the end, which is where a reader lands after narrowing a filter while
    // on a later page. Clamped to the last page rather than served empty, and it
    // says where it landed so the control can follow (D133).
    const beyond = asRecord(
      await (await api(`/clusters/${pagedId}/indexes?offset=100000&limit=25`, owner)).json(),
    );
    const beyondRows = asRecords(beyond.indexes, "beyond.indexes");
    expect(beyondRows.length).toBeGreaterThan(0);
    expect(beyond.total).toBe(count);
    // The last page boundary at 25 per page, not the raw offset: a clamp mid-page
    // would straddle two pages and the reader would see rows repeat.
    expect(beyond.offset).toBe(Math.floor((count - 1) / 25) * 25);
    // The fixture numbers from zero, so the last index is count - 1.
    expect(asRecord(beyondRows[beyondRows.length - 1] ?? {}).indexName).toBe(
      `idx_${String(count - 1).padStart(4, "0")}`,
    );

    // A limit past the ceiling is refused rather than served: the endpoint is a
    // page, and the bound is what keeps it one.
    expect((await api(`/clusters/${pagedId}/indexes?limit=100000`, owner)).status).toBe(400);
  });

  // #432. Every one of these numbers was read once an hour and thrown away:
  // `jobs/suggest.ts` used the shapes in memory and persisted only the
  // recommendations that cleared every create-side gate, so a query walking 900k
  // documents a week on a small collection was seen, priced, discarded, and
  // never mentioned to the customer.
  it("lists the scanning shapes the engine declined, and which gate declined them", async () => {
    const wlId = await bareCluster("Scanning Workload");
    const now = Date.now();
    const shapeOf = (equality: string[], over: Record<string, unknown> = {}) => ({
      equality,
      sort: [],
      range: [],
      collscan: true,
      sortedInMemory: false,
      ...over,
    });
    await db.insert(workloadShapes).values([
      // The headline case: real cost, and under every threshold.
      {
        clusterId: wlId,
        database: "app",
        collection: "orders",
        shape: shapeOf(["status"]),
        executions: 1200,
        docsExamined: 900_000,
        observedForHours: 168,
        clients: [{ application: "checkout-api", driver: "nodejs" }],
        weeklyDocsExamined: 900_000,
        severity: "ROUTINE",
        outcome: "below-cost-floor",
        proposedIndex: null,
        firstSeenAt: new Date(now - 30 * 86_400_000),
        lastSeenAt: new Date(now),
        observations: 700,
      },
      // The expensive one, which DID become a proposal.
      {
        clusterId: wlId,
        database: "app",
        collection: "events",
        shape: shapeOf(["kind"], { sortedInMemory: true }),
        executions: 40_000,
        docsExamined: 50_000_000,
        observedForHours: 168,
        clients: [{ driver: "python" }],
        weeklyDocsExamined: 50_000_000,
        severity: "CRITICAL",
        outcome: "proposed",
        proposedIndex: "kind_1",
        firstSeenAt: new Date(now - 2 * 86_400_000),
        lastSeenAt: new Date(now),
        observations: 40,
      },
      // A blocking sort whose source could not report examined documents. Its
      // weekly cost is unknown, and unknown must sort LAST rather than first:
      // Postgres puts nulls first under `desc`, so the one row whose cost nobody
      // measured would otherwise head a page ranked by cost.
      {
        clusterId: wlId,
        database: "app",
        collection: "carts",
        shape: shapeOf([], { collscan: false, sortedInMemory: true }),
        executions: 90,
        docsExamined: null,
        observedForHours: null,
        clients: [],
        weeklyDocsExamined: null,
        severity: "ROUTINE",
        outcome: "not-recurring",
        proposedIndex: null,
        firstSeenAt: new Date(now - 86_400_000),
        lastSeenAt: new Date(now),
        observations: 3,
      },
      // Outside every plan's window, so the entitlement is what keeps it off the
      // page rather than a deletion that has not run yet.
      {
        clusterId: wlId,
        database: "app",
        collection: "ancient",
        shape: shapeOf(["gone"]),
        executions: 5,
        docsExamined: 99_000_000_000,
        observedForHours: 168,
        clients: [],
        weeklyDocsExamined: 99_000_000_000,
        severity: "CRITICAL",
        outcome: "below-cost-floor",
        proposedIndex: null,
        firstSeenAt: new Date(now - 500 * 86_400_000),
        lastSeenAt: new Date(now - 400 * 86_400_000),
        observations: 10,
      },
    ]);
    // The two gates that fire BEFORE the workload is read, so they can have no
    // shape rows — the pass counts collections into its own note instead (#277).
    await db.insert(analysisNotes).values({
      clusterId: wlId,
      source: "WORKLOAD",
      decidedAt: new Date(now),
      suppressed: { "trivial-collection": 12, "oversize-collection": 2 },
    });

    const body = asRecord(await (await api(`/clusters/${wlId}/workload`, owner)).json());
    const shapes = asRecords(body.shapes, "body.shapes");
    // Worst first, by documents walked per week — and the unmeasured one last,
    // never first. The ancient row is absent whatever its cost.
    expect(shapes.map((row) => row.collection)).toEqual(["events", "orders", "carts"]);
    expect(body.total).toBe(3);
    expect(body.analysedAt).not.toBeNull();
    expect(body.workloadAnalysisEnabled).toBe(true);
    // Counted, not given rows, and reported rather than silently left out.
    expect(body.collectionsBelowDocFloor).toBe(12);
    expect(body.collectionsAboveSizeCeiling).toBe(2);

    const declined = shapes.find((row) => row.collection === "orders");
    expect(declined).toBeDefined();
    // The point of the page: the gate that declined, and the engine's own
    // sentence for it.
    expect(declined?.outcome).toBe("below-cost-floor");
    expect(String(declined?.explanation)).toContain("million documents a week");
    expect(declined?.proposedIndex).toBeNull();
    // The ESR split — what an index would have to cover — rather than a rendered
    // key pattern.
    expect(asRecord(declined?.keys).equality).toEqual(["status"]);
    // First and last seen, so a scan that started on Tuesday is distinguishable
    // from one that has been there for a month. The create side had no history
    // at all before this: recommendations are deleted and re-proposed wholesale
    // on every pass.
    expect(declined?.firstSeenAt).not.toBe(declined?.lastSeenAt);
    expect(declined?.observations).toBe(700);
    expect(asRecords(declined?.clients, "clients")[0]?.application).toBe("checkout-api");

    // A blocking sort is a different failure from a scan, and the one no scan
    // test can see.
    const sorting = shapes.find((row) => row.collection === "carts");
    expect(sorting).toMatchObject({ collscan: false, sortedInMemory: true });
    // Unmeasured, not zero: zero would read as "this costs nothing".
    expect(sorting?.weeklyDocsExamined).toBeNull();

    // The filter the page exists for.
    const onlyDeclined = asRecord(
      await (await api(`/clusters/${wlId}/workload?declinedOnly=true`, owner)).json(),
    );
    const declinedRows = asRecords(onlyDeclined.shapes, "onlyDeclined.shapes");
    expect(declinedRows.map((row) => row.collection)).toEqual(["orders", "carts"]);
    expect(onlyDeclined.total).toBe(2);

    // Namespace scoping, and the total narrows with it.
    const scoped = asRecord(
      await (await api(`/clusters/${wlId}/workload?collection=events`, owner)).json(),
    );
    expect(asRecords(scoped.shapes, "scoped.shapes")).toHaveLength(1);
    expect(scoped.total).toBe(1);

    // Switching create-side analysis off leaves NO shapes at all, because
    // nothing is read — so an empty page has two meanings and the payload says
    // which one it is.
    await api(`/clusters/${wlId}/policy`, owner, {
      method: "PUT",
      body: JSON.stringify({
        workloadAnalysis: false,
        instantCreate: false,
        observeWindowDays: 7,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: null,
        changeWindowEndHour: null,
      }),
    });
    const off = asRecord(await (await api(`/clusters/${wlId}/workload`, owner)).json());
    expect(off.workloadAnalysisEnabled).toBe(false);

    // Another tenant gets the empty shape rather than a refusal — and
    // `workloadAnalysisEnabled` true, because not-yours and switched-off are
    // different answers and only one of them is a setting.
    const stranger = await signUp("workload-stranger");
    createdEmails.push(stranger.email);
    createdOrgIds.push(asString(asRecord(await (await api("/org", stranger)).json()).id));
    const foreign = asRecord(await (await api(`/clusters/${wlId}/workload`, stranger)).json());
    expect(foreign.shapes).toEqual([]);
    expect(foreign.total).toBe(0);
    expect(foreign.workloadAnalysisEnabled).toBe(true);
    expect(foreign.analysedAt).toBeNull();
  });

  // The cursor has to cross the boundary between the measured shapes and the
  // unmeasured ones, which is what a nullable sort key makes easy to get wrong:
  // a plain tuple comparison is null-propagating, so every unmeasured shape
  // would vanish from the second page onwards.
  it("pages the scanning workload by keyset across the unmeasured shapes", async () => {
    const pagedId = await bareCluster("Workload Paging");
    const now = Date.now();
    const count = WORKLOAD_SHAPES_PAGE + 6;
    // Half of them with a cost, half without, interleaved by construction.
    await db.insert(workloadShapes).values(
      Array.from({ length: count }, (_, n) => ({
        clusterId: pagedId,
        database: "app",
        collection: "wide",
        shape: {
          equality: [`f${n}`],
          sort: [],
          range: [],
          collscan: true,
          sortedInMemory: false,
        },
        executions: 10 + n,
        docsExamined: n % 2 === 0 ? 1000 * (n + 1) : null,
        observedForHours: 168,
        clients: [],
        weeklyDocsExamined: n % 2 === 0 ? 1000 * (n + 1) : null,
        severity: "ROUTINE",
        outcome: "below-cost-floor",
        proposedIndex: null,
        firstSeenAt: new Date(now - 86_400_000),
        lastSeenAt: new Date(now),
        observations: 1,
      })),
    );

    const first = asRecord(await (await api(`/clusters/${pagedId}/workload`, owner)).json());
    const firstRows = asRecords(first.shapes, "first.shapes");
    expect(firstRows).toHaveLength(WORKLOAD_SHAPES_PAGE);
    expect(first.total).toBe(count);

    expect(first.offset).toBe(0);
    expect(first.limit).toBe(WORKLOAD_SHAPES_PAGE);

    const second = asRecord(
      await (
        await api(`/clusters/${pagedId}/workload?offset=${WORKLOAD_SHAPES_PAGE}`, owner)
      ).json(),
    );
    const secondRows = asRecords(second.shapes, "second.shapes");
    expect(secondRows).toHaveLength(count - WORKLOAD_SHAPES_PAGE);
    expect(second.offset).toBe(WORKLOAD_SHAPES_PAGE);

    // Clamped to the last page boundary past the end rather than served empty,
    // the same rule the inventory follows (D133).
    const beyond = asRecord(
      await (await api(`/clusters/${pagedId}/workload?offset=99999&limit=10`, owner)).json(),
    );
    expect(asRecords(beyond.shapes, "beyond.shapes").length).toBeGreaterThan(0);
    expect(beyond.offset).toBe(Math.floor((count - 1) / 10) * 10);
    expect(beyond.limit).toBe(10);

    // And the ceiling is enforced: this endpoint is a page, not a report.
    expect((await api(`/clusters/${pagedId}/workload?limit=99999`, owner)).status).toBe(400);

    // Every shape exactly once across the two pages, including the ones with no
    // measured cost.
    const seen = [...firstRows, ...secondRows].map((row) => String(row.id));
    expect(new Set(seen).size).toBe(count);
    const unmeasured = [...firstRows, ...secondRows].filter(
      (row) => row.weeklyDocsExamined === null,
    );
    expect(unmeasured.length).toBe(Math.floor(count / 2));
  });
});

// Which databases a cluster is observed on (#244). Its own account and its own
// cluster: this scenario connects a real string, and the outbound-dial budget is
// per user — borrowing the shared `owner` would show up as a 429 in some later,
// unrelated test.
describe("choosing which databases to observe", () => {
  const SIDE = "inttest_side";

  // A second user database on the suite's mongod, so there is something to choose
  // between. Dropped afterwards: every test that reads "whatever is on the server"
  // would otherwise inherit it.
  beforeAll(async () => {
    await mongo
      .db(SIDE)
      .collection("widgets")
      .insertMany([{ n: 1 }, { n: 2 }]);
  });

  afterAll(async () => {
    await mongo
      .db(SIDE)
      .dropDatabase()
      .catch(() => {});
  });

  it("connects observing one database of several, and walks only that one", async () => {
    const session = await signUp("observe");
    createdEmails.push(session.email);
    createdOrgIds.push(await giveRoom(session));

    // The preflight reports every user database, narrowed or not — that list is
    // what the form draws its checkboxes from.
    const checked = asRecord(
      await (
        await api("/clusters/check-connection", session, {
          method: "POST",
          body: JSON.stringify({ connectionString: MONGO_URL }),
        })
      ).json(),
    );
    const offered = Array.isArray(checked.databases) ? checked.databases.map(String) : [];
    expect(offered).toContain("inttest");
    expect(offered).toContain(SIDE);
    // Never the system databases: they are not a choice, and offering them would
    // put admin and config on the form.
    expect(offered).not.toContain("admin");
    expect(offered).not.toContain("config");

    const created = await api("/clusters", session, {
      method: "POST",
      body: JSON.stringify({
        name: "Observed Cluster",
        connectionString: MONGO_URL,
        observedDatabases: [SIDE],
      }),
    });
    expect(created.status).toBe(200);
    const body = asRecord(await created.json());
    // Read back, not just written — the same rule the TLS concessions follow.
    expect(body.observedDatabases).toEqual([SIDE]);
    const observedId = asString(body.id);
    createdClusterIds.push(observedId);

    // The proof the whole feature is for: the collect walks the selection and
    // nothing else, on a cluster whose credentials can read every database.
    expect(await collectCluster(db, observedId)).toBeGreaterThan(0);
    const walked = await db
      .selectDistinct({ database: clusterIndexes.database })
      .from(clusterIndexes)
      .where(eq(clusterIndexes.clusterId, observedId));
    expect(walked.map((row) => row.database)).toEqual([SIDE]);

    // The live list, for the settings screen: what the cluster HAS beside what we
    // are watching. `available` is deliberately not the intersection — a database
    // that is not drawn could never be ticked.
    const listed = asRecord(await (await api(`/clusters/${observedId}/databases`, session)).json());
    expect(listed.available).toContain("inttest");
    expect(listed.available).toContain(SIDE);
    expect(listed.observed).toEqual([SIDE]);

    // Widening. null means every database the cluster has, including ones added
    // later — which is why it is a null and not a list of today's names.
    const widened = await api(`/clusters/${observedId}/databases`, session, {
      method: "PUT",
      body: JSON.stringify({ databases: null }),
    });
    expect(widened.status).toBe(200);
    expect(asRecord(await widened.json()).observedDatabases).toBeNull();
    await collectCluster(db, observedId);
    const after = await db
      .selectDistinct({ database: clusterIndexes.database })
      .from(clusterIndexes)
      .where(eq(clusterIndexes.clusterId, observedId));
    expect(after.map((row) => row.database).sort()).toEqual([SIDE, "inttest"].sort());

    // A name the cluster does not have is refused rather than stored and quietly
    // intersected away by every collect afterwards.
    const bogus = await api(`/clusters/${observedId}/databases`, session, {
      method: "PUT",
      body: JSON.stringify({ databases: ["not_a_database_here"] }),
    });
    expect(bogus.status).toBe(400);

    // Nor may a cluster be left observing nothing: it would be indistinguishable
    // from a broken one on every panel afterwards.
    const empty = await api(`/clusters/${observedId}/databases`, session, {
      method: "PUT",
      body: JSON.stringify({ databases: [] }),
    });
    expect(empty.status).toBe(400);

    // And the act is on the record, like the other three that change what the
    // control plane may do with somebody's cluster.
    const events = await db
      .select({ event: securityEvents.event })
      .from(securityEvents)
      .where(eq(securityEvents.clusterId, observedId));
    expect(events.map((row) => row.event)).toContain("CLUSTER_OBSERVED_DATABASES_CHANGED");
  });

  // Postgres only — no dial, no budget. `bareCluster` has unusable sealed bytes,
  // so this also pins the deliberate degradation: a cluster that cannot be reached
  // to verify the names must not have the change refused.
  it("discards the open proposals it stops observing, and keeps the in-flight ones", async () => {
    const id = await bareCluster("Observe Proposals");
    await db.insert(recommendations).values([
      {
        clusterId: id,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "staging",
        collection: "orders",
        indexName: "idx_proposed_1",
        rationale: "unused across the trust window",
        score: 50,
        estimatedBytesSaved: 1_000,
      },
      {
        clusterId: id,
        type: "DROP_UNUSED" as const,
        state: "APPROVED" as const,
        database: "staging",
        collection: "orders",
        indexName: "idx_approved_1",
        rationale: "unused across the trust window",
        score: 50,
        estimatedBytesSaved: 1_000,
      },
      // The engine has already hidden this one on the customer's cluster, and this
      // row is the only record of that — offboarding reads exactly these states to
      // put it back. Discarding it would leave an index hidden on a database
      // nobody is watching, with nothing left that knows to unhide it.
      {
        clusterId: id,
        type: "DROP_UNUSED" as const,
        state: "HIDDEN" as const,
        database: "staging",
        collection: "orders",
        indexName: "idx_hidden_1",
        rationale: "unused across the trust window",
        score: 50,
        estimatedBytesSaved: 1_000,
        hiddenAt: new Date(),
      },
      // In a database that stays observed: untouched either way.
      {
        clusterId: id,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "app",
        collection: "orders",
        indexName: "idx_kept_1",
        rationale: "unused across the trust window",
        score: 50,
        estimatedBytesSaved: 1_000,
      },
    ]);

    const narrowed = await api(`/clusters/${id}/databases`, owner, {
      method: "PUT",
      body: JSON.stringify({ databases: ["app"] }),
    });
    expect(narrowed.status).toBe(200);

    const left = await db
      .select({ name: recommendations.indexName, state: recommendations.state })
      .from(recommendations)
      .where(eq(recommendations.clusterId, id));
    const names = left.map((row) => row.name).sort();
    expect(names).toEqual(["idx_hidden_1", "idx_kept_1"]);

    // The count reaches the trail, because it is what explains a recommendation
    // list getting shorter.
    const [event] = await db
      .select({ metadata: securityEvents.metadata })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.clusterId, id),
          eq(securityEvents.event, "CLUSTER_OBSERVED_DATABASES_CHANGED"),
        ),
      );
    expect(asRecord(event?.metadata ?? {}).discardedRecommendations).toBe(2);
  });

  // The narrow race the discard above cannot close: an approve already on its way
  // when the selection changed. Refused rather than silently ignored — the reader
  // is looking at a row on their screen.
  it("refuses to approve a proposal in a database that is no longer observed", async () => {
    const id = await bareCluster("Observe Approve");
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId: id,
        type: "DROP_UNUSED" as const,
        state: "PROPOSED" as const,
        database: "staging",
        collection: "orders",
        indexName: "idx_race_1",
        rationale: "unused across the trust window",
        score: 50,
        estimatedBytesSaved: 1_000,
      })
      .returning();
    const recId = asString(rec?.id);
    // Narrow the cluster directly, so the proposal survives the discard above and
    // only the approve is left to refuse it.
    await db
      .update(clusters)
      .set({ observedDatabases: ["app"] })
      .where(eq(clusters.id, id));

    const refused = await api(`/recommendations/${recId}/approve`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(409);
    const [after] = await db
      .select({ state: recommendations.state })
      .from(recommendations)
      .where(eq(recommendations.id, recId));
    expect(after?.state).toBe("PROPOSED");
  });
});

// A read-only cluster is the strongest form of the same problem the observed-
// database refusal above exists for: applyCluster returns before pre-flight, so
// an accepted approval sits at APPROVED with no action row and nothing anywhere
// saying it can never proceed (#257).
describe("approving on a read-only cluster", () => {
  it("refuses, naming the mode, rather than parking the row forever", async () => {
    // Clusters are read-only by default — the column's default, and the whole
    // onboarding story — so this needs no setup beyond existing.
    const id = await bareCluster("Read Only Approve");
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId: id,
        type: "DROP_REDUNDANT" as const,
        state: "PROPOSED" as const,
        database: "app",
        collection: "orders",
        indexName: "userId_1",
        rationale: "key-prefix of userId_1_name_1, which already covers it",
        score: 61,
        estimatedBytesSaved: 8_192,
      })
      .returning();
    const recId = asString(rec?.id);

    const refused = await api(`/recommendations/${recId}/approve`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(409);
    // The message, not just the status: the sibling refusal above answers 409
    // too, and a reader who cannot act needs to be told which of the two it is.
    const body = asRecord(await refused.json());
    expect(String(body.message)).toContain("read-only");

    const [after] = await db
      .select({ state: recommendations.state })
      .from(recommendations)
      .where(eq(recommendations.id, recId));
    expect(after?.state).toBe("PROPOSED");

    // And it is the MODE that refuses, not the row: the same click lands once
    // the cluster is live.
    await db.update(clusters).set({ readOnly: false }).where(eq(clusters.id, id));
    const accepted = await api(`/recommendations/${recId}/approve`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(accepted.status).toBe(200);
    const [live] = await db
      .select({ state: recommendations.state })
      .from(recommendations)
      .where(eq(recommendations.id, recId));
    expect(live?.state).toBe("APPROVED");
  });
});

// #313. The org-level rule that credentials broader than the engine needs are
// never stored, at both doors, plus the re-check that says which privileges the
// stored string actually holds.
//
// Its own org throughout: the rule changes what every connect in an org is
// allowed to do, and leaving it switched on would refuse the connects every other
// block above makes.
describe("least-privilege policy", () => {
  let strict: Session;
  let strictOrgId: string;
  // The cluster this block connects for itself, and the reason it does: the
  // privilege re-check DIALS, so it spends a dial from the budget of whoever
  // asks. Borrowing the shared `owner` session for it answered 429 in CI — that
  // session has spent its ten by this point in the file, and the symptom lands
  // on the new test rather than on the scenario that spent them.
  let strictClusterId: string;

  beforeAll(async () => {
    strict = await signUp("leastpriv");
    createdEmails.push(strict.email);
    strictOrgId = await giveRoom(strict);
    createdOrgIds.push(strictOrgId);
  });

  it("defaults to off, and says it was never configured", async () => {
    const policy = asRecord(await (await api("/org/policy", strict)).json());
    expect(policy.requireLeastPrivilege).toBe(false);
    // Not the same as configured-to-off. An install that has considered this and
    // declined must be distinguishable from one that has never seen the setting.
    expect(policy.updatedAt).toBeNull();

    // And it rides on the org payload the dashboard already reads, because the
    // connection card of every cluster needs it (#313).
    const org = asRecord(await (await api("/org", strict)).json());
    expect(asRecord(org.policy).requireLeastPrivilege).toBe(false);
  });

  it("records who changed it, and only when it moved", async () => {
    const on = await api("/org/policy", strict, {
      method: "PUT",
      body: JSON.stringify({ requireLeastPrivilege: true }),
    });
    expect(on.status).toBe(200);
    const saved = asRecord(await on.json());
    expect(saved.requireLeastPrivilege).toBe(true);
    expect(saved.updatedAt).not.toBeNull();

    // Saved a second time with the same value: one decision, so one row. A trail
    // that recorded the re-save would send an incident reader hunting for a change
    // at a timestamp where nothing changed.
    await api("/org/policy", strict, {
      method: "PUT",
      body: JSON.stringify({ requireLeastPrivilege: true }),
    });
    const trail = await db
      .select()
      .from(securityEvents)
      .where(
        and(eq(securityEvents.orgId, strictOrgId), eq(securityEvents.event, "ORG_POLICY_CHANGED")),
      );
    expect(trail).toHaveLength(1);
    expect(asRecord(trail[0]?.metadata ?? {}).to).toEqual({ requireLeastPrivilege: true });
    expect(trail[0]?.actorEmail).toBe(strict.email);
  });

  it("refuses to connect a deployment that cannot be narrowed at all", async () => {
    // The suite's mongod runs with authentication off, which is the case the issue
    // left open: it grants every privilege to anyone who can reach it, and no
    // grant narrows that. Refused rather than exempted — an exemption would mean
    // an org with this switched on still stores the broadest credential this
    // product can hold.
    const refused = await api("/clusters", strict, {
      method: "POST",
      body: JSON.stringify({ name: "Refused", connectionString: MONGO_URL }),
    });
    expect(refused.status).toBe(422);
    const body = asRecord(await refused.json());
    expect(String(body.message)).toContain("authentication disabled");
    // And provisioning is NOT offered here, because there would be nothing to
    // authenticate a scoped user as.
    expect(String(body.message)).not.toContain("provision");

    // Nothing stored. The gate runs after the dial and before the seal, so a
    // refusal must leave no row behind.
    const rows = await db.select().from(clusters).where(eq(clusters.orgId, strictOrgId));
    expect(rows).toHaveLength(0);
  });

  it("lets the same string through the moment the rule is off", async () => {
    await api("/org/policy", strict, {
      method: "PUT",
      body: JSON.stringify({ requireLeastPrivilege: false }),
    });
    const created = await api("/clusters", strict, {
      method: "POST",
      body: JSON.stringify({ name: "Allowed Again", connectionString: MONGO_URL }),
    });
    expect(created.status).toBe(200);
    strictClusterId = asString(asRecord(await created.json()).id);
    const id = strictClusterId;
    createdClusterIds.push(id);

    // Switching the rule back ON does not reach backwards: the cluster stays, and
    // the dashboard marks it out of policy instead. An org that had to choose
    // between its policy and its analysis would never switch the policy on.
    await api("/org/policy", strict, {
      method: "PUT",
      body: JSON.stringify({ requireLeastPrivilege: true }),
    });
    const still = await db.select().from(clusters).where(eq(clusters.id, id));
    expect(still).toHaveLength(1);

    // Rotation is the other door, and the only one an existing cluster has.
    const rotated = await api(`/clusters/${id}/connection`, strict, {
      method: "PATCH",
      body: JSON.stringify({ connectionString: MONGO_URL }),
    });
    expect(rotated.status).toBe(422);
    expect(String(asRecord(await rotated.json()).message)).toContain("authentication disabled");

    await api("/org/policy", strict, {
      method: "PUT",
      body: JSON.stringify({ requireLeastPrivilege: false }),
    });
  });

  it("re-checks the stored credentials and reports required beside redundant", async () => {
    const privileges = await api(`/clusters/${strictClusterId}/privileges`, strict);
    expect(privileges.status).toBe(200);
    const body = asRecord(await privileges.json());
    expect(body.reachable).toBe(true);
    // Stamped by the api, so the card can label how old the figures are rather
    // than implying they are live — the issue's first constraint.
    expect(typeof body.checkedAt).toBe("string");

    const required = Array.isArray(body.required) ? body.required.map(asRecord) : [];
    expect(required.map((check) => check.key)).toContain("indexStats");
    // PROVISION checks are dropped on this route and only here: on an existing
    // cluster the offer to make a scoped user is gone, so three rows about
    // creating users under a heading that says "what the engine needs" would be a
    // question nobody can act on.
    expect(required.map((check) => check.tier)).not.toContain("PROVISION");

    // A no-auth deployment reports no surplus, on purpose: it holds every grant
    // there is and not one of them is revocable, because there is no user to
    // revoke it from. The message carries that whole finding instead.
    expect(body.surplus).toEqual([]);
    expect(body.authEnabled).toBe(false);
  });

  it("tells another tenant nothing about the cluster id", async () => {
    // The response enumerates what a credential on somebody's production database
    // may do, which is half of what an attacker wants before using it — so the
    // route is owner-only, and a caller standing in a DIFFERENT org gets the same
    // answer a typo gets. Not found rather than forbidden, which is the rule the
    // other eight cluster routes follow: whether a cluster id exists is not this
    // caller's business, and a 403 would confirm it does.
    //
    // Free of the dial budget, and that is not incidental: ownership is checked
    // before anything is unsealed or dialled, so a caller probing ids cannot
    // spend somebody's budget — or reach a customer's host — by guessing.
    const refused = await api(`/clusters/${strictClusterId}/privileges`, owner);
    expect(refused.status).toBe(404);
  });

  afterAll(async () => {
    await db.delete(orgPolicies).where(eq(orgPolicies.orgId, strictOrgId));
  });
});

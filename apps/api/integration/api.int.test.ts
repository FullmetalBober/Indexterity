import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actions,
  clusters,
  createDatabase,
  eq,
  inArray,
  indexSnapshots,
  organizations,
  recommendations,
  roiMetrics,
  user,
  verification,
} from "../src/db";
import { applyCluster } from "../src/jobs/apply";
import { drainPool } from "../src/jobs/connection-pool";
import { applyCreatesForCluster } from "../src/jobs/create";
import { closeJobDb } from "../src/jobs/db";
import { MongoConnection } from "../src/mongo";
import {
  API_BASE,
  api,
  databaseUrl,
  MONGO_URL,
  type Session,
  signUp,
  startApi,
  stopApi,
  WEB_ORIGIN,
} from "./helpers";

// fetch().json() is unknown — narrow at the boundary, no `as`.
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...value };
  }
  throw new Error(`expected an object body, got ${JSON.stringify(value)}`);
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

let server: ChildProcess;
let db: ReturnType<typeof createDatabase>;
let mongo: MongoConnection;
let owner: Session;
let member: Session;
let switcher: Session;
let clusterId: string;

const createdEmails: string[] = [];
const createdClusterIds: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  server = await startApi();
  db = createDatabase(databaseUrl());
  mongo = new MongoConnection(MONGO_URL);
  await mongo.connect();
  owner = await signUp("owner");
  createdEmails.push(owner.email);
});

afterAll(async () => {
  // The change-window test ran job code in THIS process — release its pools.
  await drainPool();
  await closeJobDb();
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
    const rotated = await api(`/clusters/${clusterId}/connection`, owner, {
      method: "PATCH",
      body: JSON.stringify({ connectionString: "mongodb://127.0.0.1:27017" }),
    });
    expect(rotated.status).toBe(200);
    const collect = await api(`/clusters/${clusterId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(collect.status).toBe(200);
  });

  it("serves policy defaults and round-trips an update", async () => {
    const defaults = asRecord(await (await api(`/clusters/${clusterId}/policy`, owner)).json());
    expect(defaults.observeWindowDays).toBe(30);
    expect(defaults.autoApply).toBe(false);

    const put = await api(`/clusters/${clusterId}/policy`, owner, {
      method: "PUT",
      body: JSON.stringify({
        autoApply: false,
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

describe("tenancy, invites and roles", () => {
  it("keeps a fresh account isolated", async () => {
    member = await signUp("member");
    createdEmails.push(member.email);
    const list: unknown = await (await api("/clusters", member)).json();
    expect(Array.isArray(list) && list.length === 0).toBe(true);
  });

  it("invites the member into the org (single-use token)", async () => {
    const inviteRes = await api("/org/invites", owner, {
      method: "POST",
      body: JSON.stringify({ email: member.email, role: "member" }),
    });
    expect(inviteRes.status).toBe(200);
    const token = asString(asRecord(await inviteRes.json()).token);

    await api("/org", member); // materialize the shell org
    const accept = await api("/invites/accept", member, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(accept.status).toBe(200);

    const reuse = await api("/invites/accept", member, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(reuse.status).toBe(409);

    const list: unknown = await (await api("/clusters", member)).json();
    const seesCluster =
      Array.isArray(list) &&
      list.some((entry: unknown) => {
        const record = asRecord(entry);
        return record.id === clusterId;
      });
    expect(seesCluster).toBe(true);
  });

  it("blocks members from every mutation (403) but not reads", async () => {
    const mode = await api(`/clusters/${clusterId}/mode`, member, {
      method: "PATCH",
      body: JSON.stringify({ readOnly: true }),
    });
    const create = await api("/clusters", member, {
      method: "POST",
      body: JSON.stringify({ name: "nope", connectionString: MONGO_URL }),
    });
    const invite = await api("/org/invites", member, {
      method: "POST",
      body: JSON.stringify({ email: "x@int.test", role: "member" }),
    });
    const policy = await api(`/clusters/${clusterId}/policy`, member, {
      method: "PUT",
      body: JSON.stringify({
        autoApply: true,
        workloadAnalysis: false,
        instantCreate: false,
        observeWindowDays: 30,
        maxCollectionSizeBytes: null,
        autoApplyScore: null,
        changeWindowStartHour: null,
        changeWindowEndHour: null,
      }),
    });
    expect([mode.status, create.status, invite.status, policy.status]).toEqual([
      403, 403, 403, 403,
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
    const res = await api(`/clusters/${clusterId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(typeof body.snapshots === "number" && body.snapshots > 0).toBe(true);
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
    // A cluster in the shell org keeps it from being collapsed on invite-accept.
    const own = await api("/clusters", switcher, {
      method: "POST",
      body: JSON.stringify({ name: "Switcher Own", connectionString: MONGO_URL }),
    });
    expect(own.status).toBe(200);
    createdClusterIds.push(asString(asRecord(await own.json()).id));
    const ownOrg = asRecord(await (await api("/org", switcher)).json());
    createdOrgIds.push(asString(ownOrg.id));

    const inviteRes = await api("/org/invites", owner, {
      method: "POST",
      body: JSON.stringify({ email: switcher.email, role: "member" }),
    });
    const token = asString(asRecord(await inviteRes.json()).token);
    const accept = await api("/invites/accept", switcher, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(accept.status).toBe(200);

    // Two orgs now; the oldest (own shell) is active until a switch.
    const orgsBody = await (await api("/orgs", switcher)).json();
    const orgList = Array.isArray(orgsBody) ? orgsBody.map(asRecord) : [];
    expect(orgList).toHaveLength(2);
    expect(orgList.find((entry) => entry.active === true)?.orgId).toBe(asString(ownOrg.id));

    const ownerOrg = asRecord(await (await api("/org", owner)).json());
    const switchRes = await api("/orgs/switch", switcher, {
      method: "POST",
      body: JSON.stringify({ orgId: asString(ownerOrg.id) }),
    });
    expect(switchRes.status).toBe(200);
    expect(asRecord(await switchRes.json()).active).toBe(true);

    // Every subsequent request is scoped to the switched-to org.
    const clustersAfter = await (await api("/clusters", switcher)).json();
    const names = Array.isArray(clustersAfter)
      ? clustersAfter.map((entry) => asRecord(entry).name)
      : [];
    expect(names).toContain("Int Cluster");
    expect(names).not.toContain("Switcher Own");
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
    expect(username).toMatch(/^idx_[0-9a-f]{12}$/);
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
    const collect = await api(`/clusters/${provisionedId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(collect.status).toBe(200);

    await mongo.db("admin").command({ dropUser: username });
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

describe("org management", () => {
  it("renames the org (owner only)", async () => {
    const denied = await api("/org", member, {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope Corp" }),
    });
    expect(denied.status).toBe(403);
    const renamed = await api("/org", owner, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed Intcorp" }),
    });
    expect(renamed.status).toBe(200);
    const org = asRecord(await (await api("/org", owner)).json());
    expect(org.name).toBe("Renamed Intcorp");
  });

  it("guards the last owner and round-trips a role change", async () => {
    const ownerOrg = asRecord(await (await api("/org", owner)).json());
    // Target by email — switcher is also a plain member of this org.
    const rows = Array.isArray(ownerOrg.members) ? ownerOrg.members.map(asRecord) : [];
    const ownerRow = rows.find((entry) => entry.email === owner.email);
    const memberRow = rows.find((entry) => entry.email === member.email);
    if (ownerRow === undefined || memberRow === undefined) throw new Error("rows missing");

    // Demoting the sole owner is refused.
    const selfDemote = await api(`/org/members/${asString(ownerRow.userId)}`, owner, {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });
    expect(selfDemote.status).toBe(409);

    // Promote, then demote back.
    const promote = await api(`/org/members/${asString(memberRow.userId)}`, owner, {
      method: "PATCH",
      body: JSON.stringify({ role: "owner" }),
    });
    expect(promote.status).toBe(200);
    const demote = await api(`/org/members/${asString(memberRow.userId)}`, owner, {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });
    expect(demote.status).toBe(200);
  });

  it("removes a member, who falls back to a fresh shell org", async () => {
    const ownerOrg = asRecord(await (await api("/org", owner)).json());
    const memberRow = (Array.isArray(ownerOrg.members) ? ownerOrg.members.map(asRecord) : []).find(
      (entry) => entry.email === member.email,
    );
    if (memberRow === undefined) throw new Error("member row missing");
    const removed = await api(`/org/members/${asString(memberRow.userId)}`, owner, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const after = asRecord(await (await api("/org", owner)).json());
    const emails = (Array.isArray(after.members) ? after.members.map(asRecord) : []).map(
      (entry) => entry.email,
    );
    expect(emails).not.toContain(member.email);

    // The removed member's next request lazily creates a fresh shell org...
    const shell = asRecord(await (await api("/org", member)).json());
    createdOrgIds.push(asString(shell.id));
    expect(Array.isArray(shell.members) && shell.members.length === 1).toBe(true);
    // ...where they are the sole owner, so leaving is refused.
    const leave = await api("/org/leave", member, { method: "POST", body: JSON.stringify({}) });
    expect(leave.status).toBe(409);
  });

  it("lets a non-last-owner leave, falling back to their own org", async () => {
    // switcher's active org is the owner's (from the switch test); they are a
    // plain member there, so leaving works and rescopes them to their own org.
    const leave = await api("/org/leave", switcher, { method: "POST", body: JSON.stringify({}) });
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
        autoApply: false,
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
    expect(await applyCreatesForCluster(clusterId)).toBe(0);
    const [held] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(held?.state).toBe("APPROVED");

    // Clearing the window lets the same tick build it.
    await setWindow(null, null);
    expect(await applyCreatesForCluster(clusterId)).toBe(1);
    const specs = await mongo.db("inttest").collection("orders").indexes();
    expect(specs.some((spec) => spec.name === "winidx_1")).toBe(true);
    await mongo.db("inttest").collection("orders").dropIndex("winidx_1");
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
    await db.insert(indexSnapshots).values(
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

    expect(await applyCluster(clusterId)).toBe(1);
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
  });
});

describe("rate limiting (runs last — it poisons the auth budget)", () => {
  it("throttles auth brute force with 429", async () => {
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
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
  });
});

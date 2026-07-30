import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actions,
  clusters,
  createDatabase,
  eq,
  inArray,
  organizations,
  recommendations,
  user,
} from "../src/db";
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

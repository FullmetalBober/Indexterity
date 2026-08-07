import type { ChildProcess } from "node:child_process";
import { makeWorkerUtils } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitledAutomation } from "../src/billing/plans";
import {
  actions,
  and,
  clusterIndexes,
  clusters,
  createDatabase,
  eq,
  inArray,
  indexCooldowns,
  indexSnapshots,
  latencySamples,
  organizations,
  policies,
  recommendations,
  roiMetrics,
  session,
  sql,
  user,
  verification,
} from "../src/db";
import { workloadKey } from "../src/engine/ports";
import { applyCluster, promoteByScore } from "../src/jobs/apply";
import { refreshInferredWindow } from "../src/jobs/change-window";
import { classifyCluster } from "../src/jobs/classify";
import { collectCluster } from "../src/jobs/collect";
import { drainPool } from "../src/jobs/connection-pool";
import { activeCooldownKeys, cooldownKey } from "../src/jobs/cooldowns";
import { applyCreatesForCluster } from "../src/jobs/create";
import { closeJobDb, jobDb } from "../src/jobs/db";
import { finalizeCluster } from "../src/jobs/finalize";
import { planForCluster } from "../src/jobs/plan";
import { latestBaselines } from "../src/jobs/probe";
import { pruneDeadLetterJobs, pruneOldSamples } from "../src/jobs/retention";
import { suggestForCluster } from "../src/jobs/suggest";
import { MongoConnection, MongoIndexCollector } from "../src/mongo";
import { hasQueryStatsPlanMetrics, parseServerVersion } from "../src/mongo/version";
import {
  API_BASE,
  API_PORT,
  api,
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
let ownerOrgId: string;
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
    expect(await collectCluster(clusterId)).toBeGreaterThan(0);
    const queued = await api(`/clusters/${clusterId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(queued.status).toBe(200);
    expect(asRecord(await queued.json()).queued).toBe(true);
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
    // The endpoint queues; the job is what reads the cluster. Run it here so
    // the tests that follow have snapshots to work from.
    const res = await api(`/clusters/${clusterId}/collect`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(asRecord(await res.json()).queued).toBe(true);
    expect(await collectCluster(clusterId)).toBeGreaterThan(0);
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
    expect(body).toContain("validated TLS");
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
    expect(await collectCluster(provisionedId)).toBeGreaterThan(0);

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
    expect(org?.plan).toBe("FREE");
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
  it("un-hides and re-proposes instead of dropping when the counters reset", async () => {
    process.env.MASTER_KEY =
      process.env.MASTER_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    await mongo.db("inttest").collection("orders").createIndex({ outage: 1 }, { name: "outage_1" });
    await mongo
      .db("inttest")
      .command({ collMod: "orders", index: { name: "outage_1", hidden: true } });

    // Hidden a month ago, its observe window long elapsed, with a baseline
    // FAR above the live counters — exactly what a mongod restart during an
    // outage leaves behind.
    const [rec] = await db
      .insert(recommendations)
      .values({
        clusterId,
        type: "DROP_UNUSED",
        state: "HIDDEN",
        database: "inttest",
        collection: "orders",
        indexName: "outage_1",
        rationale: "outage test",
        estimatedBytesSaved: 0,
        hiddenAt: new Date(Date.now() - 30 * 86_400_000),
        observeDays: 7,
        baselineReadOps: 5_000_000,
        baselineReadLatency: 5_000_000_000,
      })
      .returning();
    if (rec === undefined) throw new Error("failed to insert recommendation");

    await finalizeCluster(clusterId);

    const [after] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    // Not dropped, and not left hidden either: restored and re-proposed.
    expect(after?.state).toBe("PROPOSED");
    expect(after?.hiddenAt).toBeNull();
    const specs = await mongo.db("inttest").collection("orders").indexes();
    const restored = specs.find((spec) => spec.name === "outage_1");
    expect(restored !== undefined && restored.hidden !== true).toBe(true);

    const trail = await db.select().from(actions).where(eq(actions.recommendationId, rec.id));
    expect(trail.some((entry) => entry.result.includes("observation lost"))).toBe(true);

    await mongo.db("inttest").collection("orders").dropIndex("outage_1");
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

    expect(await classifyCluster(idleId)).toBe(1);
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

    expect(await classifyCluster(lostId)).toBe(0);
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

    expect(await classifyCluster(gappedId)).toBe(0);
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

    expect(await classifyCluster(restartId)).toBe(0);
    const proposals = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.clusterId, restartId));
    expect(proposals).toHaveLength(0);
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

    // Second call is a conflict — it is no longer hidden.
    const again = await api(`/recommendations/${rec.id}/unhide`, owner, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);

    await coll.drop().catch(() => {});
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
    expect(await approvedNames()).toEqual(["strong_1"]);

    await seed();
    await promoteByScore(db, thresholdId, 0);
    // Everything except the advisory, which no setting may promote — an
    // approved advisory leaves the PROPOSED set classify refreshes.
    expect(await approvedNames()).toEqual(["strong_1", "weak_1"]);

    // And the threshold applyCluster reads is the stored policy value.
    await db.insert(policies).values({ clusterId: thresholdId, autoApplyScore: 95 });
    await seed();
    await applyCluster(thresholdId).catch(() => {
      // The fixture's sealed bytes are dummies, so opening a session fails —
      // after the promotion, which is the step under test.
    });
    expect(await approvedNames()).toEqual([]);
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

    // And the restructured suggest run completes against a real cluster.
    await api(`/clusters/${clusterId}/policy`, owner, {
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
    expect(await suggestForCluster(clusterId)).toBeGreaterThanOrEqual(0);
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

    expect(await classifyCluster(watchId)).toBe(0);

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

    expect(await classifyCluster(watchId)).toBe(1);
    const [proposal] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.clusterId, watchId), eq(recommendations.state, "PROPOSED")));
    expect(proposal?.type).toBe("DROP_UNUSED");
    expect(proposal?.indexName).toBe("built_1");
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
      jobDb().execute(
        sql`update graphile_worker._private_jobs
            set attempts = max_attempts, locked_at = null, locked_by = null,
                updated_at = now() - ${sql.raw(`interval '${age}'`)}
            where id::text = ${id}`,
      );
    await exhaust(staleId, "91 days");
    await exhaust(freshId, "1 hour");

    expect(await pruneDeadLetterJobs()).toBeGreaterThanOrEqual(1);

    const remaining = await jobDb().execute(
      sql`select id::text as id from graphile_worker.jobs
          where id::text in (${staleId}, ${freshId}, ${liveId})`,
    );
    const ids = remaining.rows.map((row) => row.id);
    expect(ids).not.toContain(staleId);
    // A failure from this morning is still worth reading; only old debris goes.
    expect(ids).toContain(freshId);
    expect(ids).toContain(liveId);

    await jobDb().execute(
      sql`delete from graphile_worker._private_jobs where id::text in (${freshId}, ${liveId})`,
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
    await pruneOldSamples();
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
    await pruneOldSamples();
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
    await pruneOldSamples();
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

    const previous = process.env.RETENTION_DAYS;
    process.env.RETENTION_DAYS = "7";
    try {
      await pruneOldSamples();
    } finally {
      if (previous === undefined) delete process.env.RETENTION_DAYS;
      else process.env.RETENTION_DAYS = previous;
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
    expect(await classifyCluster(narrowId)).toBe(0);
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
    await classifyCluster(narrowId);
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

    await pruneOldSamples();

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
    await collectCluster(runClusterId);
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

    await collectCluster(runClusterId);

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

    await pruneOldSamples();

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
});

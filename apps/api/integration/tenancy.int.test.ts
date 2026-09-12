import type { ChildProcess } from "node:child_process";
import { contract } from "@repo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clusterIndexes,
  clusters,
  createDatabase,
  eq,
  inArray,
  organizations,
  recommendations,
  tunnels,
  user,
} from "../src/db";
import {
  api,
  asRecord,
  asString,
  databaseUrl,
  type Session,
  signUp,
  startApi,
  stopApi,
} from "./helpers";

// Every route that names somebody else's resource, driven by somebody else.
//
// The individual refusals are tested where the feature is (events, tunnels, the
// inventory reads in api.int.test.ts). What none of those can do is notice a
// route that was ADDED and never checked: tenancy here is enforced per handler,
// by passing `context.member.orgId` down to a query that filters on it, and a
// handler that forgets is a silent hole that every existing test still passes.
//
// So this enumerates the id-bearing routes off the contract and fails if one is
// not listed below. Same shape as orpc/contract-routes.test.ts asserting that
// every route names an authorization level — a level answers "who are you", and
// this answers "is this yours", which is the question the level cannot ask.

// What each route needs beyond the id in its path, so the call is REFUSED for
// tenancy rather than rejected for a malformed body. A 400 would look like a
// refusal and prove nothing, which is why the assertions below reject it
// explicitly.
const BODIES: Record<string, unknown> = {
  renameCluster: { name: "stolen" },
  setClusterMode: { readOnly: true },
  setObservedDatabases: { databases: ["inttest"] },
  setClusterTunnel: { tunnelId: null },
  clearCooldown: { database: "inttest", collection: "orders", indexName: "idx_1" },
  triggerCollect: {},
  deleteCluster: undefined,
  rotateConnection: {
    connectionString: "mongodb://user:pass@127.0.0.1:27017/?directConnection=true",
  },
  updatePolicy: {
    workloadAnalysis: false,
    instantCreate: false,
    observeWindowDays: 7,
    maxCollectionSizeBytes: 1_000_000,
    autoApplyScore: null,
    changeWindowStartHour: null,
    changeWindowEndHour: null,
  },
  approveRecommendation: {},
  rollbackRecommendation: {},
  unhideRecommendation: { cooldownDays: 7 },
  shortenObserveWindow: { days: 1 },
  updateTunnel: { name: "stolen tunnel" },
  deleteTunnel: undefined,
  testTunnel: {},
};

interface Route {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

// The id-bearing half of the contract, read the same way
// orpc/contract-routes.test.ts reads it.
function guardedRoutes(): Route[] {
  const found: Route[] = [];
  for (const [name, procedure] of Object.entries(contract)) {
    const meta: unknown = Reflect.get(procedure, "~orpc");
    if (typeof meta !== "object" || meta === null) continue;
    const route: unknown = Reflect.get(meta, "route");
    if (typeof route !== "object" || route === null) continue;
    const method: unknown = Reflect.get(route, "method");
    const path: unknown = Reflect.get(route, "path");
    if (typeof path !== "string") continue;
    // ANY path parameter, not the two this file happened to know about: a
    // route keyed by a new kind of id is exactly the case the coverage guard
    // below exists to catch, and a narrower filter would skip it silently.
    if (!/\{\w+\}/.test(path)) continue;
    found.push({ name, method: typeof method === "string" ? method : "POST", path });
  }
  return found;
}

let server: ChildProcess;
let db: ReturnType<typeof createDatabase>;
let owner: Session;
let outsider: Session;
let clusterId: string;
let recommendationId: string;
let tunnelId: string;

const createdEmails: string[] = [];
const createdOrgIds: string[] = [];

async function orgIdOf(session: Session): Promise<string> {
  return asString(asRecord(await (await api("/org", session)).json()).id);
}

beforeAll(async () => {
  server = await startApi();
  db = createDatabase(databaseUrl(), 2);
  owner = await signUp("tenancy-owner");
  createdEmails.push(owner.email);
  // An owner of their OWN organization, not a member of nobody: a caller with
  // no org is refused by the authorization level before tenancy is reached, so
  // they cannot demonstrate anything about it.
  outsider = await signUp("tenancy-outsider");
  createdEmails.push(outsider.email);
  const orgId = await orgIdOf(owner);
  createdOrgIds.push(orgId, await orgIdOf(outsider));

  // Dummy sealed credentials: nothing on these paths has to dial, and a row is
  // enough to be somebody else's.
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "Tenancy Cluster",
      // Explicitly live, because the column DEFAULTS to read-only and the
      // stranger's setClusterMode body sends `readOnly: true`. Left at the
      // default, the assertion below could not have failed whether the write
      // was refused or not.
      readOnly: false,
      sealedDek: Buffer.from("integration-dummy"),
      sealedData: Buffer.from("integration-dummy"),
    })
    .returning({ id: clusters.id });
  if (cluster === undefined) throw new Error("cluster fixture insert returned nothing");
  clusterId = cluster.id;

  const [index] = await db
    .insert(clusterIndexes)
    .values({
      clusterId,
      database: "inttest",
      collection: "orders",
      indexName: "tenancy_1",
      spec: {
        name: "tenancy_1",
        keys: [{ field: "tenancy", direction: 1 }],
        unique: false,
        ttl: false,
        partial: false,
        partialFilter: null,
        sparse: false,
        hidden: false,
        isShardKey: false,
        collation: null,
      },
    })
    .returning({ id: clusterIndexes.id });
  if (index === undefined) throw new Error("index fixture insert returned nothing");

  // HIDDEN rather than PROPOSED, so `unhide` and `observe-window` have a row in
  // the state they act on and cannot refuse for a reason other than tenancy.
  const [rec] = await db
    .insert(recommendations)
    .values({
      clusterId,
      type: "DROP_UNUSED",
      database: "inttest",
      collection: "orders",
      indexName: "tenancy_1",
      targetSpec: null,
      rationale: "tenancy fixture",
      score: 80,
      state: "HIDDEN",
      hiddenAt: new Date(),
      observeDays: 7,
      estimatedBytesSaved: 8192,
    })
    .returning({ id: recommendations.id });
  if (rec === undefined) throw new Error("recommendation fixture insert returned nothing");
  recommendationId = rec.id;

  // Sealed bytes that decrypt to nothing, on purpose: every tunnel route checks
  // ownership before it reads the config, so a stranger must never get far
  // enough for that to matter — and if one ever does, this fixture fails loudly
  // rather than quietly dialling.
  const [tunnel] = await db
    .insert(tunnels)
    .values({
      orgId,
      name: "Tenancy Tunnel",
      sealedDek: Buffer.from("integration-dummy"),
      sealedData: Buffer.from("integration-dummy"),
    })
    .returning({ id: tunnels.id });
  if (tunnel === undefined) throw new Error("tunnel fixture insert returned nothing");
  tunnelId = tunnel.id;
}, 120_000);

afterAll(async () => {
  await db.delete(clusters).where(eq(clusters.id, clusterId));
  await db.delete(tunnels).where(eq(tunnels.id, tunnelId));
  if (createdOrgIds.length > 0)
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdEmails.length > 0) await db.delete(user).where(inArray(user.email, createdEmails));
  await db.$client.end();
  await stopApi(server);
});

function urlFor(route: Route, overrides?: { readonly nowhere: string }): string {
  const cluster = overrides?.nowhere ?? clusterId;
  const rec = overrides?.nowhere ?? recommendationId;
  const tunnel = overrides?.nowhere ?? tunnelId;
  return route.path
    .replace("{clusterId}", cluster)
    .replace("{tunnelId}", tunnel)
    .replace("{id}", rec);
}

describe("another organization's resources", () => {
  it("finds the id-bearing routes at all (guards the reflection above)", () => {
    expect(guardedRoutes().length).toBeGreaterThanOrEqual(27);
  });

  // The coverage guard, and the reason this file exists: a route added to the
  // contract with an id in its path has no body here, so it fails until somebody
  // decides what a stranger sending it should get.
  it("knows what to send to every id-bearing route", () => {
    const unlisted = guardedRoutes()
      .filter((route) => route.method !== "GET" && !(route.name in BODIES))
      .map((route) => `${route.name} ${route.method} ${route.path}`);
    expect(unlisted).toEqual([]);
  });

  it("answers a stranger with nothing, on every one of them", async () => {
    const leaked: string[] = [];
    const malformed: string[] = [];
    for (const route of guardedRoutes()) {
      const body = route.method === "GET" ? undefined : BODIES[route.name];
      const res = await api(urlFor(route), outsider, {
        method: route.method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      // A 400 is a validation refusal, which happens BEFORE any of this is
      // decided and would make a green run meaningless. Reported separately so
      // the failure says "fix the fixture", not "tenancy is broken".
      if (res.status === 400) {
        malformed.push(`${route.name}: ${text.slice(0, 160)}`);
        continue;
      }
      // Not-found rather than forbidden is the house answer: whether an id
      // exists in somebody else's org is a fact about their account
      // (http/tenancy.service.ts, assertOwnsCluster).
      //
      // Reads may answer with an EMPTY SHAPE instead — an empty panel is a read
      // of a cluster you cannot see — so a 200 is accepted there as long as it
      // carries no trace of the fixture. The echoed `clusterId` is not a trace:
      // the caller supplied it, and the same body comes back for an id that
      // never existed, which the last test here holds them to.
      //
      // A WRITE gets no such latitude. There is no empty shape for a mutation:
      // either it was refused or it happened, and a handler answering 200 while
      // quietly doing nothing would be indistinguishable here from one that did
      // the work.
      if (route.method !== "GET" && res.status !== 404) {
        leaked.push(`${route.name} ${route.method} -> ${res.status} ${text.slice(0, 160)}`);
        continue;
      }
      if (res.status !== 404 && (text.includes("Tenancy Cluster") || text.includes("tenancy_1"))) {
        leaked.push(`${route.name} ${route.method} -> ${res.status} ${text.slice(0, 200)}`);
      }
    }
    expect(malformed).toEqual([]);
    expect(leaked).toEqual([]);
  }, 60_000);

  // The half the sweep above cannot cover on its own: nothing the stranger sent
  // moved a row. Read straight from postgres rather than back through the api,
  // so a read path that hides what a write path changed cannot cover for it.
  it("left every one of them exactly as it found them", async () => {
    const [cluster] = await db
      .select({ name: clusters.name, readOnly: clusters.readOnly })
      .from(clusters)
      .where(eq(clusters.id, clusterId));
    expect(cluster?.name).toBe("Tenancy Cluster");
    // setClusterMode sends readOnly: true; the fixture is inserted live on
    // purpose, so this disagrees with the stranger's payload.
    expect(cluster?.readOnly).toBe(false);
    const [rec] = await db
      .select({ state: recommendations.state, observeDays: recommendations.observeDays })
      .from(recommendations)
      .where(eq(recommendations.id, recommendationId));
    // approve / rollback / unhide each move it out of HIDDEN, and
    // observe-window sends days: 1 against the fixture's 7.
    expect(rec?.state).toBe("HIDDEN");
    expect(rec?.observeDays).toBe(7);
    const [tunnel] = await db
      .select({ name: tunnels.name })
      .from(tunnels)
      .where(eq(tunnels.id, tunnelId));
    // updateTunnel sends a new name, deleteTunnel would remove the row entirely.
    expect(tunnel?.name).toBe("Tenancy Tunnel");
  });

  // What makes the empty-shape answers honest: they are the same answer an id
  // that never existed gets, so a stranger cannot use one to learn that a
  // cluster is real.
  it("tells a stranger the same thing about a cluster that does not exist", async () => {
    const nowhere = "00000000-0000-4000-8000-000000000000";
    for (const route of guardedRoutes()) {
      if (route.method !== "GET") continue;
      const theirs = await api(urlFor(route), outsider);
      const fictional = await api(urlFor(route, { nowhere }), outsider);
      expect(theirs.status).toBe(fictional.status);
      const mine = (await theirs.text())
        .replaceAll(clusterId, nowhere)
        .replaceAll(tunnelId, nowhere);
      expect(mine).toBe(await fictional.text());
    }
  }, 60_000);

  // The owner of the fixture can do what the stranger could not, so the refusals
  // above are about tenancy and not about the routes being broken for everybody.
  it("still answers the organization that owns them", async () => {
    const mine = await api(`/clusters/${clusterId}/policy`, owner);
    expect(mine.status).toBe(200);
    const recs = await api(`/clusters/${clusterId}/recommendations`, owner);
    expect(recs.status).toBe(200);
    expect(await recs.text()).toContain("tenancy_1");
  });
});

import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusters, createDatabase, eq, inArray, organizations, sql, user } from "../src/db";
import { API_ROOT, api, databaseUrl, type Session, signUp, startApi, stopApi } from "./helpers";

// The SSE surface end to end: the same postgres NOTIFY the worker sends, heard
// by the api's listener, fanned out to a subscribed browser — with the tenancy
// refusals and the per-cluster scoping that make it safe to expose.
//
// Deliberately mongo-free: nothing on this path dials a cluster, so the
// fixture cluster is a row with dummy sealed credentials rather than a real
// connection — which also keeps this suite off the dial budget.

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
let owner: Session;
let outsider: Session;
let clusterId: string;

const createdEmails: string[] = [];
const createdOrgIds: string[] = [];

async function orgIdOf(session: Session): Promise<string> {
  return asString(asRecord(await (await api("/org", session)).json()).id);
}

beforeAll(async () => {
  server = await startApi();
  db = createDatabase(databaseUrl(), 2);
  owner = await signUp("events-owner");
  createdEmails.push(owner.email);
  outsider = await signUp("events-outsider");
  createdEmails.push(outsider.email);
  const orgId = await orgIdOf(owner);
  createdOrgIds.push(orgId, await orgIdOf(outsider));
  const [row] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "Events Cluster",
      sealedDek: Buffer.from("integration-dummy"),
      sealedData: Buffer.from("integration-dummy"),
    })
    .returning({ id: clusters.id });
  if (row === undefined) throw new Error("cluster fixture insert returned nothing");
  clusterId = row.id;
});

afterAll(async () => {
  await db
    .delete(clusters)
    .where(eq(clusters.id, clusterId))
    .catch(() => {});
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
  await db.$client.end();
  await stopApi(server);
});

async function notify(targetClusterId: string, kind: string): Promise<void> {
  await db.execute(
    sql`select pg_notify('cluster_events', ${JSON.stringify({ clusterId: targetClusterId, kind, task: null })})`,
  );
}

describe("cluster events (SSE)", () => {
  // FIRST, and it has to be: the two refusals below never build a stream, but
  // any case that subscribes leaves the session up for its grace period. The
  // regression #223 fixed is exactly this reading being 1 from boot, for the
  // life of the process, whether or not anybody ever opened a dashboard.
  it("holds no postgres session before anybody has subscribed", async () => {
    const result = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and backend_type = 'client backend'
        and query ilike 'listen cluster_events%'
    `);
    expect(Number(result.rows[0]?.count ?? "0")).toBe(0);
  });

  it("refuses without a session", async () => {
    const res = await api(`/clusters/${clusterId}/events`, null);
    expect(res.status).toBe(401);
  });

  // NOT_FOUND, not an empty stream: an empty stream never ends, and a hung
  // subscription tells the outsider the cluster exists.
  it("refuses another org's reader outright", async () => {
    const res = await api(`/clusters/${clusterId}/events`, outsider);
    expect(res.status).toBe(404);
  });

  it("delivers this cluster's events and nobody else's", async () => {
    const res = await fetch(`${API_ROOT}/clusters/${clusterId}/events`, {
      headers: { cookie: owner.cookie, accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    if (res.body === null) throw new Error("no response body to read");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Another org's cluster id on the same channel — scoping means the frame
    // below must never reach this stream.
    const foreign = "99999999-9999-4999-8999-999999999999";
    // Repeatedly, not once: the subscription is live only once the generator's
    // first pull registers its listener, and a single NOTIFY sent in that
    // window would vanish and hang the test.
    const pump = setInterval(() => {
      void notify(foreign, "BUILD_GRADUATED").then(() => notify(clusterId, "DROP_HIDDEN"));
    }, 250);
    try {
      // The read loop cannot hang: oRPC's keepalive frames arrive every 5s,
      // so read() resolves whether or not an event came.
      const deadline = Date.now() + 20_000;
      while (!buffer.includes("DROP_HIDDEN") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      clearInterval(pump);
      await reader.cancel().catch(() => {});
    }
    expect(buffer).toContain("DROP_HIDDEN");
    // The foreign cluster's event was on the channel the whole time.
    expect(buffer).not.toContain("BUILD_GRADUATED");
    // Routing stays on the wire between processes; the stream's scope already
    // names the cluster, so no frame should carry an id.
    expect(buffer).not.toContain(clusterId);
  });
});

// The claim #223 makes is about postgres SESSIONS, so it is asserted against
// pg_stat_activity rather than against the service's own view of itself. The
// api under test is a real child process (helpers.startApi) pointed at this
// database, so its LISTEN — if it holds one — is visible from here.
describe("the listener holds a session only while somebody is subscribed", () => {
  // Every `listen cluster_events` backend on this database. The api process is
  // the only thing in this suite that opens one.
  async function listenSessions(): Promise<number> {
    const result = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and backend_type = 'client backend'
        and query ilike 'listen cluster_events%'
    `);
    return Number(result.rows[0]?.count ?? "0");
  }

  // The regression: this used to be 1 from the moment the api booted, for the
  // life of the process, whether or not anyone had ever opened a dashboard.
  it("opens one while a stream is live", async () => {
    const res = await fetch(`${API_ROOT}/clusters/${clusterId}/events`, {
      headers: { cookie: owner.cookie, accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    if (res.body === null) throw new Error("no response body to read");
    const reader = res.body.getReader();
    try {
      // Read one frame, so the generator has certainly registered its listener
      // and the acquire() has certainly run. Keepalives make this resolve even
      // with no event to deliver.
      await reader.read();
      // The connect is fire-and-forget by design, so poll rather than assume it
      // has landed by the time the first frame arrives.
      const deadline = Date.now() + 10_000;
      let sessions = 0;
      while (Date.now() < deadline) {
        sessions = await listenSessions();
        if (sessions >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(sessions).toBe(1);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });
});

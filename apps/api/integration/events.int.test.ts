import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusters, createDatabase, eq, inArray, organizations, sql, user } from "../src/db";
import {
  API_ROOT,
  api,
  databaseUrl,
  type Session,
  signUp,
  startApi,
  stopApi,
} from "./helpers";

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
  db = createDatabase(databaseUrl());
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

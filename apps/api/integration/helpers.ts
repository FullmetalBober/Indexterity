import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  and,
  clusterIndexes,
  type Database,
  eq,
  indexSnapshots,
  latencySamples,
  sql,
} from "../src/db";

export const API_PORT = Number(process.env.INT_API_PORT ?? 3099);
// The api serves everything under /api (main.ts setGlobalPrefix), so this is
// the base every call hangs off — including better-auth at /api/auth.
export const API_BASE = `http://localhost:${API_PORT}`;
export const API_ROOT = `${API_BASE}/api`;
export const WEB_ORIGIN = "http://localhost:3000";
export const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("integration tests need DATABASE_URL (a migrated postgres)");
  }
  return url;
}

// Spawn the built api and wait for /api/health. The caller owns teardown.
// extraEnv/port let a test drive a second instance with different guards.
export async function startApi(
  extraEnv: Record<string, string> = {},
  port: number = API_PORT,
): Promise<ChildProcess> {
  const entry = path.resolve(__dirname, "../dist/main.js");
  if (!existsSync(entry)) {
    throw new Error("dist/main.js missing — run `turbo run build` before the integration suite");
  }
  const child = spawn("node", [entry], {
    env: {
      ...process.env,
      API_PORT: String(port),
      WEB_ORIGIN,
      DATABASE_URL: databaseUrl(),
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "integration-secret",
      MASTER_KEY:
        process.env.MASTER_KEY ??
        Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
      // The suite's mongo is on localhost, and it signs up freely — both are
      // non-defaults, which is exactly why the guards need their own tests.
      ALLOW_PRIVATE_CLUSTER_TARGETS: "true",
      SIGNUP_MODE: "open",
      // The suite signs up an account per scenario from one address, which the
      // brute-force budget is right to distrust in production and wrong to
      // here. Same reason the e2e suite raises it.
      AUTH_RATE_LIMIT_MAX: "500",
      RATE_LIMIT_MAX: "5000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill("SIGKILL");
  throw new Error("api did not become healthy in 60s");
}

export async function stopApi(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export interface Session {
  readonly email: string;
  readonly cookie: string;
}

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

// better-auth's own endpoints, which sit on Fastify at /api/auth — outside
// Nest's controllers and so outside `api()`. Every org mutation lives here now.
export async function authPost(
  path: string,
  session: Session | null,
  body: unknown,
  base: string = API_BASE,
): Promise<Response> {
  return fetch(`${base}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      ...(session === null ? {} : { cookie: session.cookie }),
    },
    body: JSON.stringify(body),
  });
}

// Unique by construction. A slug is required and unique, nothing routes by it,
// and a suite that reruns against the same database would otherwise collide
// with its own previous run on the second `owner-org`.
export function uniqueSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "org";
  return `${base}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function createOrg(
  session: Session,
  name: string,
  base: string = API_BASE,
): Promise<string> {
  const res = await authPost(
    "/organization/create",
    session,
    { name, slug: uniqueSlug(name) },
    base,
  );
  if (res.status !== 200) throw new Error(`create org failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

// Sign up AND make an organization, because signing up no longer makes one.
//
// The api used to insert "My Org" behind the first authenticated request, so a
// session was all a test needed. Creating an org is a verb now, and everything
// below the org — connecting a cluster, reading a policy — refuses without one.
export async function signUp(prefix: string): Promise<Session> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@int.test`;
  const res = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: "password12345", name: prefix }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  const session: Session = { email, cookie: cookieOf(res) };
  await createOrg(session, `${prefix} Org`);
  return session;
}

// An account with no organization at all — the state a fresh sign-up is in
// before it makes one, and the one the dashboard draws a create screen for.
export async function signUpWithoutOrg(prefix: string): Promise<Session> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@int.test`;
  const res = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: "password12345", name: prefix }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return { email, cookie: cookieOf(res) };
}

export function sessionFrom(email: string, res: Response): Session {
  return { email, cookie: cookieOf(res) };
}

// A snapshot fixture, described the way it reads on the cluster rather than the
// way it is stored. The identity and the spec live in cluster_indexes now, so a
// test that wants "three snapshots of orders.dyn_1" would otherwise have to
// upsert a dimension row and thread its id through by hand.
//
// `lastSeenAt`/`observations` default to a run of one, which is what a fixture
// describing a single collect means. A fixture that wants a run — an index idle
// across a stretch of collects — sets them.
export interface SnapshotFixture {
  readonly clusterId: string;
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  readonly spec: Record<string, unknown>;
  readonly sizeBytes: number;
  readonly perMember: { member: string; ops: number; since?: string }[];
  readonly hinted?: boolean;
  readonly capturedAt: Date;
  readonly lastSeenAt?: Date;
  readonly observations?: number;
}

// Identity plus shape, matching what the writer keys dimension rows by. Stated
// once, because a fixture that keyed the map differently from the way it looks the
// id back up fails with "no dimension row" and sends the reader to the wrong file.
function fixtureKey(fixture: SnapshotFixture): string {
  return [
    fixture.clusterId,
    fixture.database,
    fixture.collection,
    fixture.indexName,
    JSON.stringify(fixture.spec),
  ].join("|");
}

export async function insertSnapshots(
  db: Database,
  fixtures: readonly SnapshotFixture[],
): Promise<void> {
  if (fixtures.length === 0) return;
  const ids = new Map<string, string>();
  for (const fixture of fixtures) {
    const key = fixtureKey(fixture);
    if (ids.has(key)) continue;
    await db
      .insert(clusterIndexes)
      .values({
        clusterId: fixture.clusterId,
        database: fixture.database,
        collection: fixture.collection,
        indexName: fixture.indexName,
        spec: fixture.spec,
      })
      .onConflictDoNothing();
    // One path whether the insert won or a previous scenario already created the
    // row, and it matches on the digest Postgres generated rather than on a
    // canonical form reproduced here.
    const [row] = await db
      .select({ id: clusterIndexes.id })
      .from(clusterIndexes)
      .where(
        and(
          eq(clusterIndexes.clusterId, fixture.clusterId),
          eq(clusterIndexes.database, fixture.database),
          eq(clusterIndexes.collection, fixture.collection),
          eq(clusterIndexes.indexName, fixture.indexName),
          sql`${clusterIndexes.specDigest} = encode(sha256(${JSON.stringify(fixture.spec)}::jsonb::text::bytea), 'hex')`,
        ),
      );
    if (row === undefined) throw new Error(`no dimension row for ${fixture.indexName}`);
    ids.set(key, row.id);
  }

  await db.insert(indexSnapshots).values(
    fixtures.map((fixture) => {
      const indexId = ids.get(fixtureKey(fixture));
      if (indexId === undefined) throw new Error(`no dimension row for ${fixture.indexName}`);
      return {
        clusterId: fixture.clusterId,
        indexId,
        sizeBytes: fixture.sizeBytes,
        perMember: fixture.perMember,
        hinted: fixture.hinted ?? false,
        capturedAt: fixture.capturedAt,
        lastSeenAt: fixture.lastSeenAt ?? fixture.capturedAt,
        observations: fixture.observations ?? 1,
      };
    }),
  );
}

// The same for latency_samples, which has no dimension half but does have the
// run columns. `lastSeenAt` carries no default in the schema on purpose — a row
// that claims a months-old reading was confirmed this instant is the one lie the
// trust gate cannot survive — so a fixture describing a single collect says so
// here instead of leaving it to the database.
export interface LatencyFixture {
  readonly clusterId: string;
  readonly database: string;
  readonly collection: string;
  readonly readOps: number;
  readonly readLatencyMicros: number;
  readonly writeOps: number;
  readonly writeLatencyMicros: number;
  readonly capturedAt: Date;
  readonly lastSeenAt?: Date;
  readonly observations?: number;
}

export async function insertLatency(
  db: Database,
  fixtures: readonly LatencyFixture[],
): Promise<void> {
  if (fixtures.length === 0) return;
  await db.insert(latencySamples).values(
    fixtures.map((fixture) => ({
      ...fixture,
      lastSeenAt: fixture.lastSeenAt ?? fixture.capturedAt,
      observations: fixture.observations ?? 1,
    })),
  );
}

export async function api(
  path: string,
  session: Session | null,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      // Only claim a JSON body when one is sent — fastify 400s on an empty
      // JSON body (bit the body-less DELETE).
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(session === null ? {} : { cookie: session.cookie }),
      ...init?.headers,
    },
  });
}

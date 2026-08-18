import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { coreEnv } from "../config/env";

// Does this DATABASE_URL actually deliver LISTEN/NOTIFY? Asked once, at boot, by
// the two processes that hold a LISTEN — and answered by a round trip rather than
// by looking at the hostname.
//
// Measured against a real Neon project (#233). Same project, same credentials,
// same code; only the host differed:
//
//   pooled   NOTIFY LOST
//   direct   NOTIFY DELIVERED
//
// Reproduced here against PgBouncer 1.25.2 in front of a postgres 18, which adds the
// half Neon could not show: `pool_mode=transaction` LOST it — LISTEN accepted,
// pg_notify returned, nothing arrived — and `pool_mode=session` on the same pair
// DELIVERED. So the thing that breaks is transaction pooling and not a proxy in the
// path, which is why the round trip is the test and the hostname is only ever a hint.
//
// A transaction pooler — PgBouncer, Supavisor, Neon's `-pooler` endpoint — passes
// LISTEN through without complaint and then lands the listener and the notifier on
// different backends, so the statement is ACCEPTED and the notification never
// arrives. Nothing errors and nothing logs, which is the whole reason this file
// exists: the dashboard's SSE is NOTIFY end to end (events/cluster-events.service.ts
// LISTENs, events/emit.ts calls pg_notify), so on such a URL the live updates
// silently never fire and the panels only ever refresh on their own staleTime, and
// graphile-worker's `LISTEN "jobs:insert"` degrades to polling — which turns
// WORKER_POLL_INTERVAL_MS from a query-rate knob into a proportional start delay.
//
// Refused rather than warned, on this repo's own precedent: a pooled URL is
// malformed configuration for this application in exactly the sense config/schema.ts
// already refuses, and the alternative is a dashboard that silently never updates.
//
// Open, probe, CLOSE. #223 made the SSE listener lazy precisely so an idle api holds
// zero postgres sessions, and a probe that kept its client open would hand that back
// for the life of the process. Both clients are closed before this returns, whatever
// the answer was.

// The delivery window. NOTIFY is delivered at COMMIT and both statements below run
// in autocommit, so on a working URL the payload is back within one round trip —
// two seconds is not a latency budget, it is the point past which the only
// remaining explanation is that it is never coming.
const DELIVERY_TIMEOUT_MS = 2_000;

// Attempts before refusing. A boot failure is the right answer to a pooled URL and
// the wrong answer to a postgres that happened to be restarting when this pod
// started, and for the first two seconds the two look identical — so the refusal has
// to survive a blip. Bounded, and bounded low: a probe that retried for a minute
// would be a deploy that hangs for a minute on the most common failure there is.
const ATTEMPTS = 3;
const BACKOFF_MS = 250;

// Long enough for a TCP and TLS handshake against a serverless postgres that has to
// wake up first, short enough that an unreachable database is a refusal rather than a
// hang. pg's own default here is 0, which means wait forever — and the one thing this
// probe must never do is become the reason a boot never finishes.
const CONNECT_TIMEOUT_MS = 10_000;

export class NotifyProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyProbeError";
  }
}

// What arrives on the listener when the round trip works. Structural rather than
// pg's own Notification, so the fakes in the unit tests can produce one.
export interface ProbeNotification {
  readonly channel: string;
  readonly payload?: string;
}

// What the probe needs of a pg Client. `new Client()` satisfies it, and so does a
// fake — which is the point: the case that matters most here is the one where the
// notification is simply never delivered, and no real postgres does that on demand.
export interface ProbeClient {
  // Resolving to unknown rather than void: pg's own connect() resolves to the client
  // itself, and a narrower signature here would only be a cast at the one call site
  // that hands this a real one.
  connect(): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<unknown>;
  on(event: "notification", handler: (message: ProbeNotification) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  end(): Promise<void>;
}

export type ProbeClientFactory = (connectionString: string) => ProbeClient;

export interface NotifyProbeOptions {
  // Defaults to the validated DATABASE_URL. Passed explicitly by the tests, and by
  // nothing else — a process probing a database it is not about to use would be
  // testing the wrong property.
  readonly connectionString?: string;
  readonly createClient?: ProbeClientFactory;
  readonly deliveryTimeoutMs?: number;
  readonly attempts?: number;
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

// What one round trip found. Three outcomes and not two, because "connected, LISTEN
// accepted, nothing arrived" and "never got a connection" call for opposite actions
// from whoever reads the boot log — one is a connection string to change, the other
// is a database to bring back.
type Attempt =
  | { readonly kind: "delivered" }
  | { readonly kind: "lost" }
  | { readonly kind: "broken"; readonly detail: string };

const defaultClient: ProbeClientFactory = (connectionString) =>
  new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });

// Deliberately NOT unref'd, and this is measured rather than cautious: with an
// unref'd timer here, a probe against a PgBouncer in transaction mode closed both
// clients, hit the backoff, found nothing else holding the event loop, and the
// process EXITED 0 — a boot that neither refused nor started, on precisely the URL
// this file exists to refuse. An unref'd timer says "do not stay up for this", and
// waiting for the answer is the one thing the process is up for.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// The delivery window, cleared as soon as the race is decided. Clearing rather than
// unref'ing for the reason above — and cleared on BOTH paths, so an answer that
// arrives in three milliseconds does not leave the boot holding a timer for the
// remaining one thousand nine hundred and ninety-seven.
async function arrivedWithin(arrival: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      arrival.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function close(client: ProbeClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // A failure to hang up is not a finding about LISTEN/NOTIFY, and the process is
    // either about to serve or about to exit either way.
  }
}

// One open-probe-close round trip: LISTEN on a throwaway channel from one session,
// pg_notify it from a second, and wait a bounded moment for the payload to come back.
async function roundTrip(create: () => ProbeClient, deliveryTimeoutMs: number): Promise<Attempt> {
  // Unique per attempt, so nothing else on this database can make the probe pass —
  // and neither can a leftover LISTEN from an attempt that already failed.
  const channel = `indexterity_notify_probe_${randomUUID().replaceAll("-", "")}`;
  const token = randomUUID();
  const listener = create();
  const notifier = create();
  // A pg Client that emits "error" with nothing listening takes the process down,
  // which would turn "the database blinked during the probe" into a crash carrying
  // none of the explanation below. Recorded instead, and read after the race: a
  // session that DROPPED delivers nothing for a reason that has nothing to do with
  // pooling, and reporting that as a pooled URL would send an operator off to change
  // a connection string that was fine.
  let dropped: Error | null = null;
  const record = (error: Error): void => {
    dropped ??= error;
  };
  listener.on("error", record);
  notifier.on("error", record);
  try {
    try {
      await listener.connect();
      await notifier.connect();
    } catch (error) {
      return { kind: "broken", detail: messageOf(error) };
    }
    // Registered before the LISTEN, so there is no window in which the answer could
    // arrive with nobody holding the resolve.
    let arrived: () => void = () => undefined;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    listener.on("notification", (message) => {
      if (message.channel === channel && message.payload === token) arrived();
    });
    try {
      // Quoted because the identifier is generated rather than because it could be
      // hostile; the notify side passes the same name as a PARAMETER, which is why
      // it is pg_notify and not NOTIFY.
      await listener.query(`listen "${channel}"`);
      await notifier.query("select pg_notify($1, $2)", [channel, token]);
    } catch (error) {
      return { kind: "broken", detail: messageOf(error) };
    }
    const delivered = await arrivedWithin(arrival, deliveryTimeoutMs);
    // Checked first: a notification that arrived and was followed by a dropped socket
    // still proves the property under test.
    if (delivered) return { kind: "delivered" };
    if (dropped !== null) return { kind: "broken", detail: messageOf(dropped) };
    return { kind: "lost" };
  } finally {
    // Both, always, and before this function returns rather than after the caller has
    // decided what to do about the result.
    await Promise.all([close(listener), close(notifier)]);
  }
}

// Whether the host LOOKS like a pooled endpoint. A hint, never the test: a pooler can
// be called anything (a PgBouncer of your own is `db:6432`), and a host with "pooler"
// in its name that delivers notifications is not this failure. All this decides is
// whether the refusal may name the likely fix outright.
export function looksPooled(connectionString: string): boolean {
  let host: string;
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host.includes("-pooler") || host.includes("pooler.");
}

// Deliberately without the host in it. DATABASE_URL is in SECRET_VARS, and
// config/env.ts names a secret variable without ever printing what was in it — a
// config error should not be the thing that puts a connection string in a log
// aggregator. Saying that the host matches is the whole of the hint's value anyway.
function refusal(outcome: Attempt, connectionString: string, attempts: number): string {
  if (outcome.kind === "broken") {
    return [
      "DATABASE_URL could not be tested for LISTEN/NOTIFY delivery: the probe never",
      `got a working connection, after ${attempts} attempts.`,
      "",
      `  ${outcome.detail}`,
      "",
      "This is NOT the pooled-URL failure — a pooled URL connects fine and swallows",
      "the notification instead. Something between this process and the control-plane",
      "postgres is down or refusing it, and every process here needs that database for",
      "its first request or its first job, so this refuses to start rather than coming",
      "up half-alive.",
      "",
      "See .env.example for what DATABASE_URL has to be.",
    ].join("\n");
  }
  const hint = looksPooled(connectionString)
    ? [
        "",
        'The host in DATABASE_URL names a pooled endpoint ("-pooler" / "pooler."),',
        "which is how Neon and Supabase spell theirs. Use the direct (non-pooled)",
        "endpoint — your provider shows both for the same database.",
      ]
    : [];
  return [
    "DATABASE_URL does not deliver LISTEN/NOTIFY.",
    "",
    "  A LISTEN on a throwaway channel was accepted and a pg_notify from a second",
    `  connection returned, but the notification never arrived — ${attempts} attempts.`,
    "",
    "LISTEN/NOTIFY does not survive transaction pooling: PgBouncer, Supavisor and",
    "Neon's -pooler endpoint pass LISTEN through without complaint, then land the",
    "listener and the notifier on different backends. Nothing errors, which is why",
    "this is a boot failure and not a warning — on such a URL the dashboard's live",
    "updates silently never fire (its panels only refresh on their own staleTime),",
    "and an enqueued job waits for the next poll instead of starting at once.",
    "",
    "Point DATABASE_URL at the direct, non-pooled endpoint of the same database.",
    "That costs this deployment nothing measurable: it holds about 20 connections",
    "at its defaults, which is what a pooler exists to multiplex away. Where a",
    "pooler is unavoidable, SESSION pooling delivers notifications and transaction",
    "pooling is what loses them (measured on PgBouncer 1.25, both modes).",
    ...hint,
    "",
    "See .env.example for what DATABASE_URL has to be.",
  ].join("\n");
}

// Refuse unless this DATABASE_URL delivers a notification. Called from the two
// entrypoints that hold a LISTEN — main.ts and worker.ts — and from nowhere at
// import time, so no unit test opens a connection by loading a module.
export async function probeNotify(options: NotifyProbeOptions = {}): Promise<void> {
  const connectionString = options.connectionString ?? coreEnv().DATABASE_URL;
  const create = options.createClient ?? defaultClient;
  const attempts = Math.max(1, options.attempts ?? ATTEMPTS);
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? BACKOFF_MS;
  const sleep = options.sleep ?? wait;
  // Overwritten by the first attempt — the loop below runs at least once.
  let last: Attempt = { kind: "broken", detail: "the probe did not run" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await roundTrip(() => create(connectionString), deliveryTimeoutMs);
    if (last.kind === "delivered") return;
    // Linear and short. The blip this is covering for is a restart or a failover,
    // which is over in a second or is not over at all.
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  // The LAST attempt decides which failure this was, because it is the one that
  // describes the database as it is now.
  throw new NotifyProbeError(refusal(last, connectionString, attempts));
}

// The same, for an entrypoint: a URL that cannot carry a notification is a
// misconfiguration rather than a fault, so it prints what is wrong and exits
// non-zero instead of unwinding as an unhandled rejection whose stack says only
// that a boot called a probe (config/env.ts's loadEnvOrExit, for the same reason).
export async function probeNotifyOrExit(options: NotifyProbeOptions = {}): Promise<void> {
  try {
    await probeNotify(options);
  } catch (error) {
    if (!(error instanceof NotifyProbeError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

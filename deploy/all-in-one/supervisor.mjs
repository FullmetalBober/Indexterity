// PID 1 of the all-in-one image: runs the api and the dashboard as two processes
// in one container.
//
// They stay two processes rather than one on purpose. The api is CommonJS Nest on
// Fastify and the dashboard is an ESM nitro bundle whose static handler serves the
// built assets and applies their security headers; mounting one inside the other
// means bridging a WHATWG fetch handler onto Fastify, re-implementing that static
// layer, and streaming SSR through the seam — for a container count that is
// already one. So the seam here is the process boundary, and this file's whole job
// is to make two processes behave like one container.
//
// That means three things, and they are the three a shell one-liner gets wrong:
//
//   - ONE environment describes two processes. Both read METRICS_PORT and
//     SENTRY_DSN and want different values, so those are split below rather than
//     left to whichever binds first (one of them would crash-loop on EADDRINUSE)
//     or to one Sentry project holding both services' events.
//   - SIGTERM has to reach BOTH children. `sh -c "a & b"` does not forward it, so
//     the api never runs its shutdown hooks, the Postgres pools are never drained,
//     and the runtime SIGKILLs the container ten seconds later.
//   - a container is alive or it is not. If either process dies this exits
//     non-zero, so the orchestrator restarts the container instead of leaving a
//     dashboard serving 502s from a passthrough with nothing behind it.
//
// No dependencies: it runs from the runtime image, before anything is resolved.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// Both processes read these from their own schemas, so the defaults here have to
// agree with those (apps/api/src/config/schema.ts, apps/web/src/lib/env.ts).
const API_PORT = process.env.API_PORT ?? "3001";
const METRICS_PORT = process.env.METRICS_PORT ?? "9464";

// The dashboard's listener. Not METRICS_PORT: one network namespace, and the api
// has already bound it. +1 rather than "off" because the two report different
// halves of the picture — page render time per route and the api as the dashboard
// server experiences it are visible from nowhere else.
const WEB_METRICS_PORT = process.env.WEB_METRICS_PORT ?? String(Number(METRICS_PORT) + 1);

// How long a child gets to exit on its own after SIGTERM before it is killed.
// Under the default ten-second grace period of most runtimes this never fires;
// it exists so that a wedged process cannot make the container un-stoppable.
const GRACE_MS = Number(process.env.SUPERVISOR_GRACE_MS ?? 15000);

// The container's memory ceiling, or null when there is none.
//
// This is the number V8 sizes its heap from — node reads it and takes roughly
// half as the old-space limit, which is why the same image idles at 228 MB on a
// 16 GB laptop and 104 MB under a 512 MiB limit. In every other deployment that
// is exactly right and nothing here should interfere. In THIS one it is wrong,
// and measurably: both processes read the same cgroup and each claimed 268 MB of
// one 512 MiB container. Idle they never meet, so it looks fine; under load the
// container is over budget before either process thinks it is near its own.
function cgroupMemoryLimit() {
  // cgroup v2 first, then v1. A v1 kernel reports a sentinel near 2^63 rather
  // than "max" when unlimited, hence the sanity ceiling.
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let raw;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (raw === "max") return null;
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    // Anything at or above this is "no limit set" wearing a number.
    if (bytes >= Number.MAX_SAFE_INTEGER || bytes > 1024 ** 4) return null;
    return bytes;
  }
  return null;
}

// How the budget is divided. The api carries the heavier working set — the
// control-plane reads, the Mongo driver, and the job runner when RUN_WORKER is on
// — so it gets the larger share.
//
// The third that is left over is deliberately NOT allocated, for two reasons and
// both are measured. A heap ceiling is not a process's memory: two node runtimes
// cost tens of megabytes of code, stacks and native allocation before either
// heap holds anything. And the sharpest spike here never lands in the heap at
// all — scrypt allocates roughly 32 MB OUTSIDE it per password hash in flight, so
// a handful of simultaneous sign-ins is memory no --max-old-space-size accounts
// for.
//
// The flag caps the OLD space, and V8 adds the young generation on top: asking
// for 172 was measured to produce a 184 MB ceiling. So the real division is a few
// points above these numbers, which is the other reason they are not larger.
const API_HEAP_SHARE = 0.4;
const WEB_HEAP_SHARE = 0.22;

// The floor a share is allowed to reach. Below roughly this, node spends its time
// collecting rather than serving, and it is better to let it exceed its share and
// be killed by something that says "out of memory" than to make it crawl.
const MIN_HEAP_MB = 64;

// Never overrides an operator's own --max-old-space-size: if the environment
// already carries one, the deployment has made this decision and this should not
// unmake it.
function heapOptionFor(share, limitBytes, inherited) {
  if (limitBytes === null) return null;
  if (/--max[-_]old[-_]space[-_]size/.test(inherited)) return null;
  const mb = Math.floor((limitBytes * share) / 1048576);
  return mb < MIN_HEAP_MB ? null : `--max-old-space-size=${mb}`;
}

const MEMORY_LIMIT = cgroupMemoryLimit();
const INHERITED_NODE_OPTIONS = process.env.NODE_OPTIONS ?? "";

function nodeOptionsFor(share) {
  const option = heapOptionFor(share, MEMORY_LIMIT, INHERITED_NODE_OPTIONS);
  if (option === null) return {};
  return { NODE_OPTIONS: `${INHERITED_NODE_OPTIONS} ${option}`.trim() };
}

const children = new Map();
let stopping = false;
let exitCode = 0;

function log(message) {
  // Plain text on purpose: the api's pino lines and the dashboard's own logs are
  // both on this stream, and a fake JSON envelope around this handful of
  // supervisor messages would be a third format claiming to be the second.
  console.log(`supervisor: ${message}`);
}

function start(name, entry, cwd, env) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env },
    // The children write straight to the container's stdout/stderr. Nothing is
    // parsed or re-emitted here, so `kubectl logs` and `docker logs` show exactly
    // what each process wrote.
    stdio: "inherit",
  });
  children.set(name, child);

  child.on("exit", (code, signal) => {
    children.delete(name);
    const how = signal === null ? `code ${code}` : `signal ${signal}`;
    if (stopping) {
      log(`${name} stopped (${how})`);
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    // Not during shutdown, so this is a failure however clean the exit looked: a
    // container that is meant to serve both is now serving one.
    log(`${name} exited on its own (${how}) — stopping the container`);
    exitCode = typeof code === "number" && code !== 0 ? code : 1;
    shutdown("SIGTERM");
  });

  child.on("error", (error) => {
    log(`${name} could not be started — ${String(error)}`);
    children.delete(name);
    exitCode = 1;
    shutdown("SIGTERM");
  });

  return child;
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (children.size === 0) process.exit(exitCode);
  log(`${signal} — forwarding to ${[...children.keys()].join(", ")}`);
  for (const child of children.values()) child.kill(signal);
  // unref, so a child that exits promptly is not held up by this timer.
  setTimeout(() => {
    for (const [name, child] of children) {
      log(`${name} did not exit within ${GRACE_MS}ms — SIGKILL`);
      child.kill("SIGKILL");
    }
  }, GRACE_MS).unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal));
}

// The api first, and not awaited: it needs no dashboard, while the dashboard's
// first server-side render needs it. Neither ordering is load-bearing — the
// passthrough answers 502 until the api is up, which is what the readiness probe
// is reading — but starting them in this order keeps that window as short as the
// api's own boot.
start("api", "apps/api/dist/main.js", "/app", nodeOptionsFor(API_HEAP_SHARE));

start("web", ".output/server/index.mjs", "/app/apps/web", {
  ...nodeOptionsFor(WEB_HEAP_SHARE),
  PORT: process.env.PORT ?? "3000",
  // The api is in this container. A Service address would be a round trip out of
  // the pod and back for a call that has nowhere else to go.
  API_URL: process.env.API_URL ?? `http://127.0.0.1:${API_PORT}`,
  METRICS_PORT: WEB_METRICS_PORT,
  // The dashboard is a separate app with a separate release, so it may report to
  // a separate Sentry project. Falls back to the api's, which is what the Helm
  // chart does when errorReporting.webDsn is empty.
  ...(process.env.WEB_SENTRY_DSN ? { SENTRY_DSN: process.env.WEB_SENTRY_DSN } : {}),
});

log(`api on ${API_PORT}, dashboard on ${process.env.PORT ?? "3000"}`);
if (process.env.METRICS_ENABLED === "true") {
  log(`metrics: api ${METRICS_PORT}, dashboard ${WEB_METRICS_PORT}`);
}
// Said out loud, because a heap ceiling is invisible until something dies of it
// and this is the only place that chose one.
if (MEMORY_LIMIT === null) {
  log("no container memory limit — leaving both heaps to node's own sizing");
} else {
  const ceiling = (share) => {
    const option = heapOptionFor(share, MEMORY_LIMIT, INHERITED_NODE_OPTIONS);
    return option === null ? "node's own" : `${option.split("=")[1]}MB`;
  };
  log(
    `memory limit ${Math.round(MEMORY_LIMIT / 1048576)}MB — heap ceilings: ` +
      `api ${ceiling(API_HEAP_SHARE)}, web ${ceiling(WEB_HEAP_SHARE)}`,
  );
}

import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, inArray, sql, workerWatermarks } from "../src/db";
import { API_PORT, databaseUrl, startApi, stopApi } from "./helpers";

// The externally-driven schedule, end to end against a real Postgres: what the
// tick claims, what it stamps into worker_watermarks, and — since #232 made the
// endpoint drain as well as enqueue — that the queue is actually EMPTY again
// once the drain the response reports has settled. With no clusters connected
// the scheduler passes fan out to nothing, so the drain is cheap and the
// assertions stay about the mechanism rather than about a fleet.
const PORT = API_PORT + 6;
const SECRET = "t".repeat(48);
const PASSES = [
  "scheduleCollect",
  "scheduleSuggest",
  "scheduleApply",
  "scheduleProbe",
  "scheduleFinalize",
  "retention",
  "digest",
];

let server: ChildProcess;
let db: ReturnType<typeof createDatabase>;

const TICK_URL = `http://localhost:${PORT}/api/internal/tick`;

async function tick(
  token: string | null,
): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
  const res = await fetch(TICK_URL, {
    method: "GET",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    body: await res.json(),
    cacheControl: res.headers.get("cache-control"),
  };
}

// Read through graphile-worker's own tables, which are `_private_` by name and
// normalise the identifier into _private_tasks. Coupling a test to them is a
// deliberate, narrow bet: the point of this suite is that a row really lands in
// the QUEUE, and the only alternative is trusting the endpoint's own report of
// itself.
//
// Sampling this the instant the response lands is what #280 turned out to be,
// and the reason is inside graphile-worker rather than anywhere in this repo: a
// worker fires `completeJob(job)` and `failJob(…)` WITHOUT awaiting either
// (dist/worker.js — the call, then straight into `doNext()`), so it polls, finds
// nothing, exits, and the pool resolves while the DELETE for the job it just
// finished is still in flight. Measured against postgres 18 with graphile-worker
// 0.17.3: `runOnce` resolved with the last one or two rows still present in 24
// of 25 rounds, `locked_at` set and `attempts = 1` — they RAN — and gone a few
// milliseconds later. `digest` is the one that shows up, because it is last in
// BURST_SCHEDULE and so the last claimed.
//
// So the queue is read once it has SETTLED instead: a locked row is one a worker
// is still answering for, and when none is left, every completion and every
// failure this drain produced has landed. Then "no rows" means what it looks
// like it means. Both halves were measured — the settled read is 0/25 false
// failures where the naive one was 24/25, and a dispatcher rigged to throw is
// still caught, sitting unlocked on `attempts = 1`.
const DISPATCHER_ROWS = sql`
  select t.identifier, j.locked_at is not null as locked, j.attempts
  from graphile_worker._private_jobs j
  join graphile_worker._private_tasks t on t.id = j.task_id
  where t.identifier = any(string_to_array(${PASSES.join(",")}, ','))
  order by t.identifier`;

// A type alias rather than an interface: `db.execute<T>` constrains T to
// Record<string, unknown>, and only an alias of an object literal gets the
// implicit index signature that satisfies it.
type DispatcherRow = {
  readonly identifier: string;
  readonly locked: boolean;
  readonly attempts: number;
};

// Whatever the drain left behind, read after it stopped moving. The budget is
// generous against how long these seven actually take — a dispatcher only
// ENQUEUES per-cluster work (the dialing is in the `collect` jobs, which are not
// in PASSES), so it is the fan-out tail that can outlive the 25s request, not
// these. A row still locked when the budget runs out is returned rather than
// waited on forever, so the assertion fails with the state that caused it.
async function settledDispatchers(budgetMs = 5_000): Promise<DispatcherRow[]> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { rows } = await db.execute<DispatcherRow>(DISPATCHER_ROWS);
    if (!rows.some((row) => row.locked) || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function clearQueue(): Promise<void> {
  await db.execute(sql`
    delete from graphile_worker._private_jobs j
    using graphile_worker._private_tasks t
    where t.id = j.task_id
      and t.identifier = any(string_to_array(${PASSES.join(",")}, ','))`);
}

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  // A clean slate: watermarks decide what is due, so a previous run's rows
  // would make the first tick dispatch nothing.
  await db.delete(workerWatermarks).where(
    inArray(
      workerWatermarks.key,
      PASSES.map((task) => `pass:${task}`),
    ),
  );
  await clearQueue();
  server = await startApi({ RUN_CRONJOB: "false", CRON_TRIGGER_SECRET: SECRET }, PORT);
}, 120_000);

afterAll(async () => {
  await stopApi(server);
  await clearQueue();
  await db.$client.end();
});

describe("GET /api/internal/tick", () => {
  // The method IS the contract here, so it is asserted rather than assumed: a
  // POST-based scheduler left over from before must fail loudly instead of
  // silently doing nothing. Unauthenticated on purpose — an unrouted verb is
  // refused before any handler of ours runs, which is the whole point.
  it("does not answer POST at all", async () => {
    const res = await fetch(TICK_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(404);
    expect(await settledDispatchers()).toEqual([]);
  });

  // A cacheable GET is the one failure a state-changing GET can have that a POST
  // could not: an intermediary hands the scheduler the previous answer and the
  // pipeline stops without anything reporting a problem. The header comes from
  // http/security-headers.ts, which applies it to every response — asserted HERE
  // because this is the endpoint where losing it would be silent.
  //
  // Read off the unauthorised answer deliberately: the hook is global, so any
  // response proves it, and an authorised call here would spend the first tick
  // that the dispatch test below is written against.
  it("refuses without a token, and forbids any intermediary from reusing it", async () => {
    const { body, cacheControl } = await tick(null);
    expect(body).toEqual({ error: "unauthorized" });
    expect(cacheControl).toBe("no-store, max-age=0");
    expect(await settledDispatchers()).toEqual([]);
  });

  it("refuses a wrong token", async () => {
    expect((await tick("w".repeat(48))).body).toEqual({ error: "unauthorized" });
    expect(await settledDispatchers()).toEqual([]);
  });

  // A fresh install has no watermarks, so the first tick owes every pass — which
  // is right: nothing has been collected, and waiting for the top of the hour is
  // a worse first impression than a busy minute. Since #232 the request also
  // DRAINS. What is asserted is that the seven dispatcher jobs are gone from the
  // queue because they RAN — they are the first claims of the drain, so they
  // execute inside the bounded window whatever else is in the database. Read once
  // the queue has settled rather than the instant the response lands, which is
  // the whole of #280; see settledDispatchers.
  //
  // `drained` itself is deliberately not asserted true: this suite shares its
  // postgres with everything run before it, so the dispatchers fan out a collect
  // per cluster that EXISTS here, and whether that tail beats the 25 s deadline
  // is a fact about the leftover fleet, not about the endpoint. drained:false is
  // a documented, resumable answer — the deadline race has its own unit tests —
  // and the shape is pinned below so the contract cannot quietly lose the field.
  it("dispatches every due pass on the first tick, and runs the dispatchers", async () => {
    const { status, body } = await tick(SECRET);
    expect(status).toBe(200);
    const outcome = body as { dispatched: string[]; drained: boolean };
    expect(outcome.dispatched.sort()).toEqual([...PASSES].sort());
    expect(typeof outcome.drained).toBe("boolean");
    expect(await settledDispatchers()).toEqual([]);
  });

  // The property that makes this safe to expose to anything that can fetch a
  // URL: a second call inside the same buckets claims nothing, so hammering it
  // cannot run the fleet twice. Asserted per bucket rather than as a flat empty
  // list,
  // because the first tick above may legitimately hold its request for the full
  // 25 s deadline (its drain walks whatever fleet this database carries), and a
  // wall clock that crosses a five-minute boundary in that window makes
  // scheduleApply/scheduleProbe genuinely due again — that is the schedule
  // working, not a duplicate. What can NEVER appear here is an hourly, daily or
  // weekly pass inside its own bucket; one of those would be the double
  // dispatch this endpoint exists to prevent. The strict same-bucket case is
  // unit-tested in burst.test.ts, where `now` is injected.
  it("re-dispatches nothing whose bucket has not rolled, on a second tick", async () => {
    const { body } = await tick(SECRET);
    const dispatched = (body as { dispatched: string[] }).dispatched;
    const fiveMinute = ["scheduleApply", "scheduleProbe"];
    expect(dispatched.filter((task) => !fiveMinute.includes(task))).toEqual([]);
    expect(await settledDispatchers()).toEqual([]);
  });

  it("comes due again once a bucket rolls over", async () => {
    // Wind the five-minute passes back past their bucket, exactly as time would.
    await db.execute(
      sql`update worker_watermarks set at = at - interval '6 minutes'
          where key in ('pass:scheduleApply', 'pass:scheduleProbe')`,
    );
    const { body } = await tick(SECRET);
    expect((body as { dispatched: string[] }).dispatched.sort()).toEqual([
      "scheduleApply",
      "scheduleProbe",
    ]);
  });
});

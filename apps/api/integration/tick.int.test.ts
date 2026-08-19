import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, inArray, sql, workerWatermarks } from "../src/db";
import { API_PORT, databaseUrl, startApi, stopApi } from "./helpers";

// The externally-driven schedule, end to end against a real Postgres: what the
// tick claims, what it stamps into worker_watermarks, and — since #232 made the
// endpoint drain as well as enqueue — that the queue is actually EMPTY again
// once the response says so. With no clusters connected the scheduler passes
// fan out to nothing, so the drain is cheap and the assertions stay about the
// mechanism rather than about a fleet.
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

async function tick(token: string | null): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost:${PORT}/api/internal/tick`, {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

// Read through graphile-worker's own tables, which are `_private_` by name and
// normalise the identifier into _private_tasks. Coupling a test to them is a
// deliberate, narrow bet: the point of this suite is that a row really lands in
// the QUEUE, and the only alternative is trusting the endpoint's own report of
// itself.
const QUEUED = sql`
  select t.identifier
  from graphile_worker._private_jobs j
  join graphile_worker._private_tasks t on t.id = j.task_id
  where t.identifier = any(string_to_array(${PASSES.join(",")}, ','))`;

async function queuedTasks(): Promise<string[]> {
  const result = await db.execute<{ identifier: string }>(QUEUED);
  return result.rows.map((row) => row.identifier).sort();
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

describe("POST /api/internal/tick", () => {
  it("refuses without a token", async () => {
    expect((await tick(null)).body).toEqual({ error: "unauthorized" });
    expect(await queuedTasks()).toEqual([]);
  });

  it("refuses a wrong token", async () => {
    expect((await tick("w".repeat(48))).body).toEqual({ error: "unauthorized" });
    expect(await queuedTasks()).toEqual([]);
  });

  // A fresh install has no watermarks, so the first tick owes every pass — which
  // is right: nothing has been collected, and waiting for the top of the hour is
  // a worse first impression than a busy minute. Since #232 the request also
  // DRAINS. What is asserted is that the seven dispatcher jobs are gone from the
  // queue because they RAN — they are the first claims of the drain, so they
  // execute inside the bounded window whatever else is in the database.
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
    expect(await queuedTasks()).toEqual([]);
  });

  // The property that makes this safe to expose to anything that can POST: a
  // second call inside the same buckets claims nothing, so hammering it cannot
  // run the fleet twice. Asserted per bucket rather than as a flat empty list,
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
    expect(await queuedTasks()).toEqual([]);
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

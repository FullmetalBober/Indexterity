import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, inArray, sql, workerWatermarks } from "../src/db";
import { API_PORT, databaseUrl, startApi, stopApi } from "./helpers";

// The externally-driven schedule, end to end against a real Postgres: the half
// worth testing is what lands in the QUEUE and in worker_watermarks, and neither
// exists in the unit suite.
//
// RUN_WORKER stays false here on purpose. This suite is about the endpoint —
// which passes it claims and enqueues — and a runner would drain the rows out
// from under the assertions while they are being read.
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
  server = await startApi(
    { RUN_WORKER: "false", RUN_CRONJOB: "false", CRON_TRIGGER_SECRET: SECRET },
    PORT,
  );
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
  // a worse first impression than a busy minute.
  it("enqueues every due pass on the first tick", async () => {
    const { status, body } = await tick(SECRET);
    expect(status).toBe(200);
    expect((body as { dispatched: string[] }).dispatched.sort()).toEqual([...PASSES].sort());
    expect(await queuedTasks()).toEqual([...PASSES].sort());
  });

  // The property that makes this safe to expose to anything that can POST: a
  // second call inside the same buckets claims nothing, so hammering it cannot
  // run the fleet twice.
  it("enqueues nothing on an immediate second tick", async () => {
    const { body } = await tick(SECRET);
    expect((body as { dispatched: string[] }).dispatched).toEqual([]);
    // Still one of each — the jobs from the first tick, not duplicates.
    expect(await queuedTasks()).toEqual([...PASSES].sort());
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

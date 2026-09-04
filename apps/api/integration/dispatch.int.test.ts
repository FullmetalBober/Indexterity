import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, sql } from "../src/db";
import { runningPasses } from "../src/jobs/dispatch";
import { databaseUrl } from "./helpers";

// The one read the dispatcher makes of graphile-worker's own table (#454): which
// clusters have a pass locked right now, so that pass is not re-keyed — which
// would clear its key and spend every retry it has. Against a real postgres with
// the worker schema installed, because the shape of `_private_jobs` is the
// library's and nothing in a unit test can vouch for it.
//
// No api and no mongo: a job is added through the library's own `add_job`, locked
// by hand the way a claiming worker locks it, read, and removed.

const CLUSTER = "dispatch-int-00000000-0000-4000-8000-000000000001";
const KEY = `collect:${CLUSTER}`;

let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  await db.execute(sql`
    select graphile_worker.add_job(
      'collect', ${JSON.stringify({ clusterId: CLUSTER })}::json, ${KEY}, null, 5, ${KEY})`);
});

afterAll(async () => {
  await db
    .execute(sql`
      update graphile_worker._private_jobs set locked_at = null, locked_by = null where key = ${KEY}`)
    .catch(() => {});
  await db.execute(sql`select graphile_worker.remove_job(${KEY})`).catch(() => {});
  await db
    .execute(sql`delete from graphile_worker._private_job_queues where queue_name = ${KEY}`)
    .catch(() => {});
  await db.$client.end();
});

describe("runningPasses", () => {
  it("does not report a pass that is merely queued", async () => {
    expect((await runningPasses(db).locked("collect")).has(CLUSTER)).toBe(false);
  });

  it("reports the cluster once its job is locked, for that task only", async () => {
    await db.execute(sql`
      update graphile_worker._private_jobs
         set locked_at = now(), locked_by = 'dispatch-int-test'
       where key = ${KEY}`);
    expect((await runningPasses(db).locked("collect")).has(CLUSTER)).toBe(true);
    expect((await runningPasses(db).locked("probe")).has(CLUSTER)).toBe(false);
  });

  it("forgets it once the lock is released", async () => {
    await db.execute(sql`
      update graphile_worker._private_jobs
         set locked_at = null, locked_by = null
       where key = ${KEY}`);
    expect((await runningPasses(db).locked("collect")).has(CLUSTER)).toBe(false);
  });
});

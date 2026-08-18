import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { apiEnv } from "../config/env";
import { sql } from "../db";
import { DatabaseService } from "../db/database.service";
import { claimDuePasses } from "./burst";

// The schedule, driven from outside (RUN_CRONJOB=false).
//
// The api owns no crontab in this mode, so something external — a platform cron,
// a CI schedule, a uptime pinger that can POST — says "now". This endpoint does
// exactly one thing with that: work out which passes became due and ENQUEUE
// them. It never drains, which is what keeps it a millisecond-scale request
// instead of one held open for the length of a collect (#226's problem). The
// api's own runner holds `LISTEN "jobs:insert"`, so the work starts the instant
// the row lands.
//
// Safe to call as often as you like, and that is a property rather than a
// promise: passes are claimed against their OCCURRENCE in worker_watermarks, so
// a hundred calls inside one five-minute bucket enqueue at most one
// scheduleApply. Under that, dispatchToAllClusters dedups again per cluster and
// task. Nothing here needs a lock.
@Controller("internal")
export class TickController {
  constructor(private readonly database: DatabaseService) {}

  @Post("tick")
  @HttpCode(200)
  async tick(
    @Headers("authorization") authorization?: string,
  ): Promise<{ dispatched: string[]; alreadyClaimed: string[] } | { error: string }> {
    const env = apiEnv();
    // Off unless the schedule is external. Answering here while the crontab is
    // installed would mean two clocks that cannot see each other, and every
    // pass running twice.
    if (env.RUN_CRONJOB) {
      return { error: "this deployment owns its own schedule (RUN_CRONJOB=true)" };
    }
    const secret = env.CRON_TRIGGER_SECRET;
    // Unreachable — the schema refuses to boot RUN_CRONJOB=false without it —
    // and checked anyway, because the cost of being wrong is an open endpoint
    // that runs the pipeline.
    if (secret === undefined || !presented(authorization, secret)) {
      return { error: "unauthorized" };
    }
    const result = await claimDuePasses(this.database.db, (task) =>
      // The same enqueue the dashboard's collect button makes, through the pool
      // this process already holds rather than a second one: a request that
      // opens its own pool per tick is a connection leak on a schedule.
      //
      // The job key guards the window between claiming a pass and this insert
      // landing — a tick that claimed and then died leaves a pending job the
      // next tick must not duplicate.
      this.database.db.execute(
        sql`select graphile_worker.add_job(
              ${task}::text,
              job_key => ${`tick:${task}`}::text,
              job_key_mode => 'preserve_run_at')`,
      ),
    );
    return { dispatched: [...result.dispatched], alreadyClaimed: [...result.alreadyClaimed] };
  }
}

// Compared in constant time, over a hash so the comparison is length-agnostic —
// timingSafeEqual throws on a length mismatch, and throwing on the wrong length
// leaks the length.
function presented(authorization: string | undefined, secret: string): boolean {
  if (authorization === undefined) return false;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  if (match === null) return false;
  const given = createHash("sha256")
    .update(match[1] ?? "")
    .digest();
  const want = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, want);
}

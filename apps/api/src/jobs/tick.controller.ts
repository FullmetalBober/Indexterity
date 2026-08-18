import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { apiEnv } from "../config/env";
import { TickService } from "./tick.service";

// How long a request may hold the connection before answering with the drain
// still running. 25 seconds, because the platform request-timeout floors #226
// measured are 30-60s (Render, Railway, Fly proxies) and the response has to be
// out before the strictest of them cuts the socket — a timed-out request looks
// like a failed tick to the scheduler that sent it, which then alerts on a
// pipeline that is actually fine.
const TICK_REQUEST_DEADLINE_MS = 25_000;

// The schedule, driven from outside (RUN_CRONJOB=false).
//
// The api owns no clock in this mode, so something external — a platform cron,
// a CI schedule, an uptime pinger that can POST — says "now". What "now" does
// depends on whether this process executes jobs:
//
//   RUN_WORKER=true   the same tick the in-process interval runs (#231): claim
//                     what became due, enqueue it, DRAIN it with runOnce. There
//                     is no resident runner and no `LISTEN "jobs:insert"` any
//                     more, so if this request did not drain, nothing would.
//                     Bounded at TICK_REQUEST_DEADLINE_MS: past it the response
//                     says drained:false while the drain carries on in-process,
//                     and a partially drained queue is a RESUMABLE state — the
//                     occurrence claims and job keys make the next ping cheap
//                     and duplicate-free.
//
//   RUN_WORKER=false  enqueue only, exactly as #227 built it. The standalone
//                     worker still holds its own LISTEN (until #232), so the
//                     work starts the instant the row lands and this request
//                     stays millisecond-scale.
//
// Safe to call as often as you like, and that is a property rather than a
// promise: passes are claimed against their OCCURRENCE in worker_watermarks, so
// a hundred calls inside one five-minute bucket enqueue at most one
// scheduleApply. Under that, dispatchToAllClusters dedups again per cluster and
// task, and concurrent drains are serialised inside TickService. Nothing here
// needs a lock.
@Controller("internal")
export class TickController {
  constructor(private readonly tickService: TickService) {}

  @Post("tick")
  @HttpCode(200)
  async tick(
    @Headers("authorization") authorization?: string,
  ): Promise<
    { dispatched: string[]; alreadyClaimed: string[]; drained?: boolean } | { error: string }
  > {
    const env = apiEnv();
    // Off unless the schedule is external. Answering here while the in-process
    // interval is running would mean two clocks that cannot see each other, and
    // every pass running twice.
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
    if (env.RUN_WORKER) {
      const outcome = await this.tickService.tickWithin(TICK_REQUEST_DEADLINE_MS);
      return {
        dispatched: [...outcome.dispatched],
        alreadyClaimed: [...outcome.alreadyClaimed],
        drained: outcome.drained,
      };
    }
    const result = await this.tickService.enqueueDue();
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

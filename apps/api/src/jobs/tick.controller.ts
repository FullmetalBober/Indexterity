import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Get, Headers, Inject } from "@nestjs/common";
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
// a CI schedule, an uptime pinger — says "now", and this request runs the same
// tick the in-process interval runs (#231): claim what became due, enqueue it,
// DRAIN it with runOnce. Nothing LISTENs and no other process exists (#232), so
// if this request did not drain, nothing would. Bounded at
// TICK_REQUEST_DEADLINE_MS: past it the response says drained:false while the
// drain carries on in-process, and a partially drained queue is a RESUMABLE
// state — the occurrence claims and job keys make the next ping cheap and
// duplicate-free.
//
// GET, and ONLY GET (#315). This endpoint changes state, so by the letter of
// HTTP it wants POST — that is what it was until the method turned out to be
// the thing standing between an operator and a working schedule. The audience
// for an external clock is the host that sleeps, and the schedulers such a host
// comes with are overwhelmingly URL pingers: an uptime monitor, a platform
// cron field that takes a URL, a status-page checker. Most of them send GET
// and nothing else. A verb they cannot send is a schedule they cannot drive,
// and every one of those operators had to bring a second machine running curl
// just to re-spell the request.
//
// What HTTP actually asks of a safe method is that an INTERMEDIARY may repeat
// or reuse it without asking, and both halves of that are already answered
// here. Repeating is free by construction (see below) — this is the rare
// state-changing endpoint that a prefetch genuinely cannot hurt. Reuse is
// refused explicitly: http/security-headers.ts puts `cache-control: no-store`
// on every response this api sends, so no proxy, CDN or browser may hand a
// second caller the first one's answer and quietly stop ticking. Without that
// header a cached 200 would be the worst failure this endpoint has — a
// scheduler that keeps getting told the pipeline ran while nothing runs at all.
//
// POST is not kept alongside it. Two verbs for one action would double what a
// misconfiguration can look like and hide which one an operator's scheduler is
// really sending; the endpoint is a switch, not an API surface with clients to
// keep. An old POST-based scheduler gets a 404, which is loud, immediate and
// says exactly what to change.
//
// Safe to call as often as you like, and that is a property rather than a
// promise: passes are claimed against their OCCURRENCE in worker_watermarks, so
// a hundred calls inside one five-minute bucket enqueue at most one
// scheduleApply. Under that, dispatchToAllClusters dedups again per cluster and
// task, and concurrent drains are serialised inside TickService. Nothing here
// needs a lock.
/**
 * The one thing the controller asks of the tick: run one, within a deadline.
 *
 * Nest injects the real `TickService`, which satisfies this structurally, so the
 * module wiring is unchanged — and a test hands over a complete object instead
 * of a class it implements one method of.
 */
export interface Ticker {
  tickWithin: TickService["tickWithin"];
}

@Controller("internal")
export class TickController {
  // The TOKEN is the class and the TYPE is the port. Nest resolves injection
  // from runtime metadata and an interface erases to Object, so a bare
  // `tickService: Ticker` compiles and then fails to boot — which no typecheck
  // and no unit test in this repo would have caught.
  constructor(@Inject(TickService) private readonly tickService: Ticker) {}

  // No @HttpCode, because GET already answers 200 — which is what @HttpCode(200)
  // was saying under POST, so the status of every arm is unchanged by the move.
  //
  // Worth being plain about what that means, since it is a wart rather than a
  // design: the refusals answer 200 as well, so the status code ALONE does not
  // tell a caller whether it got a tick. The body does — `error` or the
  // dispatched/drained shape — and a scheduler that alerts on non-2xx will not
  // notice a wrong token. Left as it is here on purpose: changing it is a
  // change to what every existing external clock sees, which is not this
  // issue's to make.
  @Get("tick")
  async tick(
    @Headers("authorization") authorization?: string,
  ): Promise<
    { dispatched: string[]; alreadyClaimed: string[]; drained: boolean } | { error: string }
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
    const outcome = await this.tickService.tickWithin(TICK_REQUEST_DEADLINE_MS);
    return {
      dispatched: [...outcome.dispatched],
      alreadyClaimed: [...outcome.alreadyClaimed],
      drained: outcome.drained,
    };
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

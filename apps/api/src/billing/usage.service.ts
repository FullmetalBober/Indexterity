import { Injectable } from "@nestjs/common";
import { and, type Database, eq, invites, members, ne } from "../db";

// How much of a plan is already spent (#354). plans.ts says what the limits ARE
// and stays a set of pure functions; this counts against them, and needs the pool
// to do it.
//
// The Database and not DatabaseService, with billing.module.ts registering a
// factory that unwraps one — better-auth's organization plugin counts seats too,
// from hooks built at import time over their own pool, and this is what lets them
// do it without a cast.
@Injectable()
export class UsageService {
  constructor(private readonly db: Database) {}

  // What a seat is, in one place.
  //
  // Members PLUS outstanding invites, deliberately: an invite is a seat already
  // promised, and not counting it would let an org invite past its plan and leave
  // the refusal for whoever clicks the link — which punishes the wrong person.
  //
  // It is counted from two directions now. The api counts it before creating an
  // invite (TenancyService.requireRoomFor), and better-auth's organization plugin
  // counts it again in its own invite and accept hooks, because those endpoints
  // are the plugin's and never pass through a Nest controller. One definition, so
  // the two cannot drift apart into two limits with one name.
  //
  // `excludeInvite` is the invitation being accepted right now: it is about to
  // stop being pending and start being a member, so counting it as both would
  // refuse the last seat in an org that has room for it.
  async seatsUsed(orgId: string, excludeInvite?: string): Promise<number> {
    const [current, pending] = await Promise.all([
      this.db.select({ id: members.id }).from(members).where(eq(members.orgId, orgId)),
      this.db
        .select({ id: invites.id })
        .from(invites)
        .where(
          and(
            eq(invites.orgId, orgId),
            eq(invites.status, "pending"),
            excludeInvite === undefined ? undefined : ne(invites.id, excludeInvite),
          ),
        ),
    ]);
    return current.length + pending.length;
  }
}

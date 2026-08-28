import { Injectable } from "@nestjs/common";
import { account, and, type Database, eq, gt, invites, sql, user } from "../db";
import { ALLOWED, decideSignup, type SignupDecision, signupMode } from "./signup-gate";

// The two refusals in this directory that need the pool (#354): may this address
// sign up at all, and does this account have a password to protect with a second
// factor.
//
// NOT a Nest guard, and the name says gate on purpose. Both are asked from inside
// better-auth's own `hooks.before`, which runs before Nest sees the request — a
// `CanActivate` could not be reached from there, and could not see the oRPC
// contract's auth level either, which is where the api's own route checks live
// (orpc/implement.ts). There are no guards in this app and this is not one.
//
// Everything else in auth/ stays a plain module-scope function: `requireSession`
// reads the auth singleton, `toWebHeaders` and the cookie helpers are pure, and
// `rate-limit.ts` and `organization.ts` are configuration better-auth is handed at
// import time. None of them holds anything to inject.
//
// The Database and not DatabaseService, with auth.module.ts registering a factory
// that unwraps one — `auth/auth.config.ts` builds better-auth at import time over
// its own pool by decision, and constructs this the same way.
@Injectable()
export class GatesService {
  constructor(private readonly db: Database) {}

  // Whether this account can sign in with a password at all.
  //
  // The owner second-factor requirement (#55) applies exactly to these accounts:
  // a password is what a stolen laptop or a phished inbox can replay, and TOTP is
  // the second thing they would also need. An account that arrived through GitHub
  // has no password here to steal and brings its provider's own second factor —
  // and better-auth refuses to enrol a TOTP for it anyway (2FA is a
  // credential-account feature), so demanding one would demand the impossible.
  async hasCredentialAccount(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
      .limit(1);
    return row !== undefined;
  }

  async evaluateSignup(email: string): Promise<SignupDecision> {
    const mode = signupMode();
    if (mode === "open") return ALLOWED;
    const [existing] = await this.db.select({ total: sql<number>`count(*)::int` }).from(user);
    const isFirstUser = (existing?.total ?? 0) === 0;
    if (mode === "closed") return decideSignup(mode, { isFirstUser, hasPendingInvite: false });
    const [pending] = await this.db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.email, email.toLowerCase()),
          eq(invites.status, "pending"),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return decideSignup(mode, { isFirstUser, hasPendingInvite: pending !== undefined });
  }
}

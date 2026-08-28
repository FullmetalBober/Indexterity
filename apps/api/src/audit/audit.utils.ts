import { Injectable } from "@nestjs/common";
import type { SecurityEventName } from "@repo/contracts";
import type { AuthHookContext, SecurityEventInput, TrailActor } from "./audit.types";

// The trail's pure half (#354): deciding WHICH event a request was, and building
// the row for it. No pool and no request object — every method here is a function
// of its arguments, which is what makes the interesting half of this directory
// reasonable about without a server.
//
// Injectable, and also plain: `new AuditUtils()` is all it takes, because the
// class holds no state and asks for nothing. That matters because the busiest
// caller cannot inject — `auth/auth.config.ts` builds better-auth at import time,
// before any container exists (#354) — so it constructs one directly. The Nest
// side injects the same class.
@Injectable()
export class AuditUtils {
  // Where the client came from, as far as this deployment can honestly tell.
  //
  // Both readers are header-only: better-auth is handed a synthetic Request built
  // from Fastify's parsed one (main.ts), so there is no socket to fall back to, and
  // the api's own handlers use Fastify's already-resolved `request.ip`.
  //
  // The leftmost X-Forwarded-For entry is the client as the first proxy saw it, and
  // it is only read when the deployment says a proxy is in front — otherwise a
  // client sets its own and the trail records whatever it fancied. Pure, so the
  // choice is testable without a request.
  clientFromHeaders(
    headers: Headers | undefined,
    trustProxy: boolean,
  ): { ipAddress: string | null; userAgent: string | null } {
    const userAgent = headers?.get("user-agent") ?? null;
    if (!trustProxy) return { ipAddress: null, userAgent };
    const forwarded = headers?.get("x-forwarded-for") ?? "";
    const client = forwarded.split(",")[0]?.trim() ?? "";
    return { ipAddress: client === "" ? null : client, userAgent };
  }

  // Which act a better-auth route amounts to, or null for one that is not an act.
  //
  // Pure, so the mapping is a unit test rather than something only an integration
  // run can check. `ok` is whether the endpoint answered rather than
  // refused: a sign-in that failed is the interesting half of a sign-in, and every
  // other path here is only worth a row when it actually happened.
  //
  // Paths are better-auth's, relative to its base — the same strings its own
  // rate-limit rules match on.
  authEventFor(path: string, ok: boolean): SecurityEventName | null {
    if (path.startsWith("/sign-in")) return ok ? "SIGN_IN" : "SIGN_IN_FAILED";
    // Before the ok-gate: a wrong code is the interesting half, same as a wrong
    // password. TOTP and backup code land on the same pair — which kind is in
    // the path, and the path is stored on the row.
    if (
      path === "/two-factor/verify-totp" ||
      path === "/two-factor/verify-backup-code" ||
      path === "/two-factor/verify-otp"
    ) {
      return ok ? "TWO_FACTOR_VERIFIED" : "TWO_FACTOR_FAILED";
    }
    if (!ok) return null;
    if (path === "/two-factor/enable") return "TWO_FACTOR_ENABLED";
    if (path === "/two-factor/disable") return "TWO_FACTOR_DISABLED";
    if (path === "/two-factor/generate-backup-codes") return "TWO_FACTOR_CODES_REGENERATED";
    if (path === "/two-factor/send-otp") return "TWO_FACTOR_OTP_SENT";
    if (path === "/change-email") return "EMAIL_CHANGE_REQUESTED";
    // Not in the issue's list, and it belongs there: a sign-up creates a session
    // without a sign-in, so without this the first session an account ever holds
    // would be the one with no row explaining where it came from. The refusal side
    // is already covered — SIGNUP_MODE turning someone away is a 403 from the
    // signup gate, not an account.
    if (path.startsWith("/sign-up")) return "ACCOUNT_CREATED";
    if (path === "/sign-out") return "SIGN_OUT";
    if (path.startsWith("/revoke-session")) return "SESSION_REVOKED";
    if (path === "/revoke-other-sessions") return "SESSION_REVOKED";
    if (path === "/organization/create") return "ORG_CREATED";
    if (path === "/organization/delete") return "ORG_DELETED";
    if (path === "/organization/update-member-role") return "MEMBER_ROLE_CHANGED";
    if (path === "/organization/remove-member") return "MEMBER_REMOVED";
    if (path === "/organization/leave") return "MEMBER_LEFT";
    if (path === "/organization/invite-member") return "INVITE_CREATED";
    if (path === "/organization/accept-invitation") return "INVITE_ACCEPTED";
    return null;
  }

  private field(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return Reflect.get(value, key);
  }

  private text(value: unknown, key: string): string | null {
    const found = this.field(value, key);
    return typeof found === "string" && found !== "" ? found : null;
  }

  // The org the act belongs to: what the caller named, else what the endpoint
  // answered with, else whichever org the acting session was looking at.
  private orgOf(ctx: AuthHookContext, actor: TrailActor | null): string | null {
    const returned = ctx.context.returned;
    return (
      this.text(ctx.body, "organizationId") ??
      this.text(returned, "organizationId") ??
      this.text(this.field(returned, "invitation"), "organizationId") ??
      this.text(this.field(returned, "member"), "organizationId") ??
      (ctx.path === "/organization/create" ? this.text(returned, "id") : null) ??
      actor?.activeOrgId ??
      null
    );
  }

  // Turned into a row, or null when the request was not one of the acts. Pure: the
  // database, the clock and the insert are all AuditService's.
  authTrailEntry(
    ctx: AuthHookContext,
    actor: TrailActor | null,
    trustProxy: boolean,
  ): SecurityEventInput | null {
    const path = ctx.path;
    if (path === undefined) return null;
    // An APIError is an Error, so this covers every refusal without depending on
    // better-auth's error class: a 403 on someone else's invitation, a rejected
    // password, a plan limit.
    const ok = !(ctx.context.returned instanceof Error);
    const event = this.authEventFor(path, ok);
    if (event === null) return null;
    // Recorded from the session that ended, not from the request. See
    // sessionEndedEntry.
    if (event === "SIGN_OUT") return null;

    // The columns every act shares. Not `satisfies SecurityEventInput`: `event` is
    // still the whole union here, and an act that records specifics may only be
    // paired with ITS specifics — so the three cases below re-state the narrowed
    // `event` alongside their metadata, and that pairing is what gets checked.
    const base = {
      orgId: this.orgOf(ctx, actor),
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      ...this.clientFromHeaders(ctx.headers, trustProxy),
    };

    switch (event) {
      // Nobody proved who they were, so the address goes in `target` rather than in
      // `actor`: it is what was claimed, not who acted.
      case "SIGN_IN_FAILED":
        return {
          ...base,
          event,
          orgId: null,
          actorUserId: null,
          actorEmail: null,
          target: this.text(ctx.body, "email"),
        };
      // Deliberately no target. `/revoke-session` identifies the session by its
      // token, and a token is a live credential — an audit table is the last place
      // it should be copied to. Which session it was is recoverable from the
      // sign-in rows and the time; the credential is not worth storing to save that.
      case "SESSION_REVOKED":
        return {
          ...base,
          event,
          metadata: { scope: path === "/revoke-session" ? "one" : "others" },
        };
      case "MEMBER_ROLE_CHANGED":
        return {
          ...base,
          event,
          target:
            this.text(this.field(ctx.context.returned, "user"), "email") ??
            this.text(ctx.body, "memberId") ??
            this.text(ctx.body, "memberIdOrEmail"),
          metadata: { role: this.text(ctx.body, "role") },
        };
      case "MEMBER_REMOVED":
        return { ...base, event, target: this.text(ctx.body, "memberIdOrEmail") };
      case "MEMBER_LEFT":
        return { ...base, event, target: actor?.email ?? null };
      case "INVITE_CREATED":
        return {
          ...base,
          event,
          target: this.text(ctx.body, "email"),
          metadata: { role: this.text(ctx.body, "role") },
        };
      // Accepted by the invited person, so actor and target are the same address —
      // said twice on purpose, because the interesting fact is that this account
      // gained a membership, and a reader scanning the target column should see it.
      case "INVITE_ACCEPTED":
        return { ...base, event, target: actor?.email ?? null };
      case "ORG_CREATED":
        return { ...base, event, target: this.text(ctx.context.returned, "name") };
      case "ORG_DELETED":
        return { ...base, event, target: this.text(ctx.body, "organizationId") };
      default:
        return { ...base, event };
    }
  }

  // A session that has just been deleted, from `databaseHooks.session.delete`.
  //
  // This is the only place a sign-out can be recorded with an actor: the row being
  // deleted carries the user, and by the time any after-middleware runs there is no
  // session left to resolve from the request. Revocations are NOT recorded here even
  // though they also delete sessions — the middleware sees those with the revoker's
  // own session intact, and revoking in bulk does not delete row by row.
  //
  // `path` null means nothing was requested: expiry cleanup, a cascade, a script.
  // Those are not acts and get no row.
  sessionEndedEntry(input: {
    readonly path: string | null | undefined;
    readonly actor: TrailActor | null;
    readonly headers: Headers | undefined;
    readonly trustProxy: boolean;
  }): SecurityEventInput | null {
    if (input.path !== "/sign-out") return null;
    const event: SecurityEventName = "SIGN_OUT";
    return {
      event,
      orgId: input.actor?.activeOrgId ?? null,
      actorUserId: input.actor?.userId ?? null,
      actorEmail: input.actor?.email ?? null,
      ...this.clientFromHeaders(input.headers, input.trustProxy),
    };
  }
}

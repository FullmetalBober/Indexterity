import { describe, expect, it } from "vitest";
import type { AuthHookContext, TrailActor } from "./audit.types";
import { AuditUtils } from "./audit.utils";

// Constructed, not booted. The class holds no state and asks for nothing, which is
// the property that lets `auth/auth.config.ts` build one at import time too — so a
// test that reached for a TestingModule would be testing the container instead of
// the mapping.
const utils = new AuditUtils();

// The caller, as the wiring resolves them with better-auth's own
// `getSessionFromCtx` — the hook context itself carries no session, which is what
// made every org event land anonymous until the integration suite said so.
function actor(over: Partial<TrailActor> = {}): TrailActor {
  return {
    userId: "user-1",
    email: "owner@example.test",
    activeOrgId: "org-1",
    ...over,
  };
}

function ctx(over: Partial<AuthHookContext> & { context?: object } = {}): AuthHookContext {
  return {
    path: "/organization/invite-member",
    headers: new Headers({ "user-agent": "Firefox/1" }),
    ...over,
    context: { ...over.context },
  } as AuthHookContext;
}

describe("authEventFor", () => {
  it("records a sign-in whether or not it worked", () => {
    expect(utils.authEventFor("/sign-in/email", true)).toBe("SIGN_IN");
    expect(utils.authEventFor("/sign-in/email", false)).toBe("SIGN_IN_FAILED");
    expect(utils.authEventFor("/sign-in/social", true)).toBe("SIGN_IN");
  });

  // A refused act did not happen, and a trail of attempts at everything would
  // bury the ones that did. Sign-in is the exception: a failed one is the whole
  // point of watching sign-ins.
  it("records nothing else that was refused", () => {
    for (const path of [
      "/sign-out",
      "/organization/remove-member",
      "/organization/update-member-role",
    ]) {
      expect(utils.authEventFor(path, false)).toBeNull();
    }
  });

  // A sign-up is a session nobody signed in for, so it gets its own row rather
  // than none.
  it("records an account being created", () => {
    expect(utils.authEventFor("/sign-up/email", true)).toBe("ACCOUNT_CREATED");
    expect(utils.authEventFor("/sign-up/email", false)).toBeNull();
  });

  it("maps the acts that decide who can do everything else", () => {
    expect(utils.authEventFor("/organization/update-member-role", true)).toBe(
      "MEMBER_ROLE_CHANGED",
    );
    expect(utils.authEventFor("/organization/remove-member", true)).toBe("MEMBER_REMOVED");
    expect(utils.authEventFor("/organization/leave", true)).toBe("MEMBER_LEFT");
    expect(utils.authEventFor("/organization/invite-member", true)).toBe("INVITE_CREATED");
    expect(utils.authEventFor("/organization/accept-invitation", true)).toBe("INVITE_ACCEPTED");
    expect(utils.authEventFor("/organization/create", true)).toBe("ORG_CREATED");
    expect(utils.authEventFor("/organization/delete", true)).toBe("ORG_DELETED");
    expect(utils.authEventFor("/revoke-session", true)).toBe("SESSION_REVOKED");
    expect(utils.authEventFor("/revoke-sessions", true)).toBe("SESSION_REVOKED");
    expect(utils.authEventFor("/revoke-other-sessions", true)).toBe("SESSION_REVOKED");
  });

  // The second factor (#55). A wrong code is a credential attempt, so the
  // verify pair records its failures like sign-in does — and unlike everything
  // else here.
  it("records the second factor's lifecycle, and its failures", () => {
    expect(utils.authEventFor("/two-factor/enable", true)).toBe("TWO_FACTOR_ENABLED");
    expect(utils.authEventFor("/two-factor/enable", false)).toBeNull();
    expect(utils.authEventFor("/two-factor/disable", true)).toBe("TWO_FACTOR_DISABLED");
    expect(utils.authEventFor("/two-factor/generate-backup-codes", true)).toBe(
      "TWO_FACTOR_CODES_REGENERATED",
    );
    for (const path of [
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
      "/two-factor/verify-otp",
    ]) {
      expect(utils.authEventFor(path, true)).toBe("TWO_FACTOR_VERIFIED");
      expect(utils.authEventFor(path, false)).toBe("TWO_FACTOR_FAILED");
    }
    // The one second factor whose delivery leaves the building, so the sending
    // is an act of its own: a burst of these is somebody working a password.
    expect(utils.authEventFor("/two-factor/send-otp", true)).toBe("TWO_FACTOR_OTP_SENT");
    expect(utils.authEventFor("/two-factor/send-otp", false)).toBeNull();
  });

  // The request is the act with the actor behind it; the flip happens on a
  // verify-email link whose path cannot be told from signup verification.
  it("records an email change being requested", () => {
    expect(utils.authEventFor("/change-email", true)).toBe("EMAIL_CHANGE_REQUESTED");
    expect(utils.authEventFor("/change-email", false)).toBeNull();
  });

  // Reading a session, listing invitations, switching org: traffic, not acts.
  it("ignores the routes that are reads", () => {
    for (const path of ["/get-session", "/organization/list", "/organization/set-active"]) {
      expect(utils.authEventFor(path, true)).toBeNull();
    }
  });
});

describe("clientFromHeaders", () => {
  it("reads the forwarded client only when a proxy is trusted", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.9, 10.0.0.5",
      "user-agent": "Chrome/1",
    });
    expect(utils.clientFromHeaders(headers, true)).toEqual({
      ipAddress: "203.0.113.9",
      userAgent: "Chrome/1",
    });
    // Untrusted, the header is whatever the client typed — a recorded address that
    // is worse than none, because it looks like evidence.
    expect(utils.clientFromHeaders(headers, false)).toEqual({
      ipAddress: null,
      userAgent: "Chrome/1",
    });
  });

  it("survives a request with no headers at all", () => {
    expect(utils.clientFromHeaders(undefined, true)).toEqual({ ipAddress: null, userAgent: null });
    expect(utils.clientFromHeaders(new Headers(), true)).toEqual({
      ipAddress: null,
      userAgent: null,
    });
  });
});

describe("authTrailEntry", () => {
  it("credits a sign-in to the session it just created", () => {
    const entry = utils.authTrailEntry(
      ctx({ path: "/sign-in/email", body: { email: "owner@example.test" } }),
      actor(),
      false,
    );
    expect(entry).toMatchObject({
      event: "SIGN_IN",
      actorUserId: "user-1",
      actorEmail: "owner@example.test",
      orgId: "org-1",
      userAgent: "Firefox/1",
    });
  });

  // Nobody proved who they were, so the address typed is the TARGET. Recording it
  // as the actor would put an unauthenticated claim in the column a reader trusts.
  it("records a failed sign-in against nobody", () => {
    const entry = utils.authTrailEntry(
      ctx({
        path: "/sign-in/email",
        body: { email: "victim@example.test" },
        context: { returned: new Error("invalid password") },
      }),
      null,
      false,
    );
    expect(entry).toMatchObject({
      event: "SIGN_IN_FAILED",
      actorUserId: null,
      actorEmail: null,
      orgId: null,
      target: "victim@example.test",
    });
  });

  // The token identifying the session IS the session credential. An audit table
  // is the last place to copy one to, so the row says which scope and no more.
  it("never stores the revoked session's token", () => {
    const entry = utils.authTrailEntry(
      ctx({ path: "/revoke-session", body: { token: "a-live-session-token" } }),
      actor(),
      false,
    );
    expect(entry).toMatchObject({ event: "SESSION_REVOKED", metadata: { scope: "one" } });
    expect(JSON.stringify(entry)).not.toContain("a-live-session-token");
  });

  it("names who was promoted, to what, and by whom", () => {
    const entry = utils.authTrailEntry(
      ctx({
        path: "/organization/update-member-role",
        body: { memberId: "member-9", role: "owner", organizationId: "org-2" },
        context: { returned: { id: "member-9", user: { email: "newowner@example.test" } } },
      }),
      actor(),
      false,
    );
    expect(entry).toMatchObject({
      event: "MEMBER_ROLE_CHANGED",
      actorEmail: "owner@example.test",
      target: "newowner@example.test",
      orgId: "org-2",
      metadata: { role: "owner" },
    });
  });

  it("names the address an invitation went to, and its role", () => {
    const entry = utils.authTrailEntry(
      ctx({
        path: "/organization/invite-member",
        body: { email: "invited@example.test", role: "member" },
      }),
      actor(),
      false,
    );
    expect(entry).toMatchObject({
      event: "INVITE_CREATED",
      target: "invited@example.test",
      metadata: { role: "member" },
      orgId: "org-1",
    });
  });

  // The org is not in the body of an accept — it is in what the endpoint answered
  // with, and the row is useless without it.
  it("finds the org of an accepted invitation in the response", () => {
    const entry = utils.authTrailEntry(
      ctx({
        path: "/organization/accept-invitation",
        body: { invitationId: "inv-3" },
        context: { returned: { invitation: { organizationId: "org-7" }, member: { id: "m-1" } } },
      }),
      actor({ activeOrgId: null }),
      false,
    );
    expect(entry).toMatchObject({
      event: "INVITE_ACCEPTED",
      orgId: "org-7",
      target: "owner@example.test",
    });
  });

  it("finds the org of a newly created one in its id", () => {
    const entry = utils.authTrailEntry(
      ctx({
        path: "/organization/create",
        body: { name: "Acme", slug: "acme" },
        context: { returned: { id: "org-new", name: "Acme" } },
      }),
      actor({ activeOrgId: null }),
      false,
    );
    expect(entry).toMatchObject({ event: "ORG_CREATED", orgId: "org-new", target: "Acme" });
  });

  it("is silent on a route that is not an act", () => {
    expect(utils.authTrailEntry(ctx({ path: "/get-session" }), actor(), false)).toBeNull();
    expect(utils.authTrailEntry(ctx({ path: undefined }), actor(), false)).toBeNull();
  });

  // A sign-out is recorded from the session that ended, not from the request that
  // ended it — by then there is nothing left to resolve. So the middleware has to
  // stay quiet about it, or the trail gets a second, actorless row for every one.
  it("leaves a sign-out to the session-delete hook", () => {
    expect(utils.authTrailEntry(ctx({ path: "/sign-out" }), actor(), false)).toBeNull();
  });
});

describe("sessionEndedEntry", () => {
  it("credits a sign-out to the session that ended", () => {
    const entry = utils.sessionEndedEntry({
      path: "/sign-out",
      actor: actor(),
      headers: new Headers({ "user-agent": "Safari/1" }),
      trustProxy: false,
    });
    expect(entry).toMatchObject({
      event: "SIGN_OUT",
      actorUserId: "user-1",
      actorEmail: "owner@example.test",
      orgId: "org-1",
      userAgent: "Safari/1",
    });
  });

  // Expiry cleanup, a cascade, a script: a session ending is not always somebody
  // ending it, and a row that claims otherwise is worse than no row.
  it("records nothing for a deletion with no request behind it", () => {
    expect(
      utils.sessionEndedEntry({
        path: null,
        actor: actor(),
        headers: undefined,
        trustProxy: false,
      }),
    ).toBeNull();
  });

  // Revocations delete sessions too, and the middleware records those with the
  // revoker's own session intact. Recording them here as well would double every
  // one.
  it("records nothing for a revocation", () => {
    expect(
      utils.sessionEndedEntry({
        path: "/revoke-session",
        actor: actor(),
        headers: undefined,
        trustProxy: false,
      }),
    ).toBeNull();
  });
});

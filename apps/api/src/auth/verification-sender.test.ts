import { describe, expect, it } from "vitest";
import { isResendRequest, verificationLandingUrl } from "./auth.config";

// Which of the three requests that reach `sendVerificationEmail` is the one the
// reader ASKED for. Only that one waits on SMTP and reports a failure; the other
// two send the mail alongside something else and must not pay the transport's
// timeout (see the comment on the sender).
//
// Worth a unit test rather than an integration one because getting it backwards
// is silent in both directions: too narrow and the resend goes back to answering
// 200 into a void, too wide and a sign-up is holding a connection open again —
// and neither shows up as a failing request.
describe("isResendRequest", () => {
  it("recognises the resend endpoint under the api's mount", () => {
    expect(
      isResendRequest(
        new Request("https://indexterity.example.com/api/auth/send-verification-email"),
      ),
    ).toBe(true);
  });

  // The base is whatever BETTER_AUTH_URL says, so the match cannot be on a
  // whole URL or a fixed prefix.
  it("recognises it on any base, port and mount", () => {
    expect(
      isResendRequest(new Request("http://localhost:3001/api/auth/send-verification-email")),
    ).toBe(true);
    expect(isResendRequest(new Request("http://api:3001/auth/send-verification-email"))).toBe(true);
  });

  it("ignores a query string, which the client may add", () => {
    expect(
      isResendRequest(new Request("http://localhost:3001/api/auth/send-verification-email?x=1")),
    ).toBe(true);
  });

  // The two incidental senders. A sign-up that waited on SMTP is the 122.5-second
  // bug this whole change exists to keep fixed.
  it("does not match the paths that send the mail alongside something else", () => {
    expect(isResendRequest(new Request("http://localhost:3001/api/auth/sign-up/email"))).toBe(
      false,
    );
    expect(isResendRequest(new Request("http://localhost:3001/api/auth/sign-in/email"))).toBe(
      false,
    );
  });

  // Not a prefix or a substring match: a path that merely ends in something
  // similar, or contains the name elsewhere, is a different endpoint.
  it("does not match a lookalike path", () => {
    expect(
      isResendRequest(new Request("http://localhost:3001/api/auth/send-verification-email/retry")),
    ).toBe(false);
  });

  // Called outside a request. Nothing does this today; false keeps the send
  // detached, which is the answer that cannot make anything worse.
  it("says no when there is no request", () => {
    expect(isResendRequest(undefined)).toBe(false);
  });
});

// Where the emailed link puts the reader afterwards (#324). Rewritten in the
// sender rather than at the callers, so this is where the rule is pinned: it has
// to fix the default WITHOUT touching a destination somebody chose, and the two
// callers that choose one (change-email) and cannot choose one (the send that
// rides along with a refused sign-in) both depend on that distinction.
describe("verificationLandingUrl", () => {
  const LINK = "https://api.example.com/api/auth/verify-email?token=abc";

  it("sends the default landing to /verified on the dashboard's origin", () => {
    const out = new URL(
      verificationLandingUrl(`${LINK}&callbackURL=%2F`, "https://app.example.com"),
    );
    expect(out.searchParams.get("callbackURL")).toBe("https://app.example.com/verified");
    // Everything else about the link is better-auth's and must survive.
    expect(out.searchParams.get("token")).toBe("abc");
    expect(out.pathname).toBe("/api/auth/verify-email");
  });

  // better-auth omits the parameter entirely on some paths; that is the same
  // "nobody said" as the "/" it writes on the rest.
  it("treats an absent callbackURL as the default too", () => {
    const out = new URL(verificationLandingUrl(LINK, "https://app.example.com"));
    expect(out.searchParams.get("callbackURL")).toBe("https://app.example.com/verified");
  });

  // The change-email link, which is opened by somebody already signed in and
  // belongs back on their account page. Rewriting it would be a regression in a
  // flow that was already correct.
  it("leaves a destination the caller chose alone", () => {
    const chosen = `${LINK}&callbackURL=${encodeURIComponent("/app/account")}`;
    expect(verificationLandingUrl(chosen, "https://app.example.com")).toBe(chosen);
  });

  it("does not double the slash on an origin that carries one", () => {
    const out = new URL(verificationLandingUrl(LINK, "https://app.example.com/"));
    expect(out.searchParams.get("callbackURL")).toBe("https://app.example.com/verified");
  });

  // A link this cannot parse is still a link somebody is waiting for, so it goes
  // out unchanged rather than not at all.
  it("hands back anything it cannot parse", () => {
    expect(verificationLandingUrl("not a url", "https://app.example.com")).toBe("not a url");
  });
});

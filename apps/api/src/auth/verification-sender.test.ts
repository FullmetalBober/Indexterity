import { describe, expect, it } from "vitest";
import { isResendRequest } from "./auth.config";

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

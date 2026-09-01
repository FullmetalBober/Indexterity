// Signing in, signing up, signing out, and the two halves of a password reset.
//
// All of these change who is asking, so they invalidate the session rather than
// a key: every cached answer belonged to the previous identity. The one that
// does not is the reset-link request, which changes nothing at all.
//
// The calls go straight to better-auth on the api, same origin, so the session
// cookie it sets is this app's cookie. They used to go through server functions
// that relayed the request and every Set-Cookie back — see lib/auth-client.ts.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { field } from "~/lib/narrow";
import { authClient } from "../../auth-client";
import { invalidateSession } from "../client";
import { queryKeys } from "../keys";

// better-auth answers with { data, error } rather than throwing, so a refusal
// arrives as a resolved promise and is branched on here. onError underneath is
// what catches the request that got no answer at all.
interface Answer {
  // Unknown on purpose: better-auth types each endpoint's data individually
  // and the twoFactorClient's `twoFactorRedirect` marker is not on any of
  // them — it is a runtime answer, so it is read by a guard rather than a type.
  readonly data?: unknown;
  readonly error: {
    readonly message?: string;
    readonly code?: string;
    readonly status?: number;
  } | null;
}

// A sign-in that answered "now the code" instead of a session (#55).
function wantsSecondFactor(data: unknown): boolean {
  return typeof data === "object" && data !== null && field(data, "twoFactorRedirect") === true;
}

// Did this answer actually carry a session? better-auth returns a token with one
// and omits it without, which is what a sign-up on an install requiring email
// verification does — it creates the account and deliberately mints nothing
// (#306). Read as a guard for the same reason wantsSecondFactor is: the shape is
// a runtime answer, not a per-endpoint type.
function hasSession(data: unknown): boolean {
  return typeof data === "object" && data !== null && typeof field(data, "token") === "string";
}

// better-auth's refusal for an unverified address, which rides on 403. Matched by
// code first because the status is shared — 403 is also what a signup-gate
// refusal and the owner-2FA gate answer, and neither is fixed by a resend.
function needsEmailVerification(error: Answer["error"]): boolean {
  if (error === null) return false;
  if (error.code === "EMAIL_NOT_VERIFIED") return true;
  return error.status === 403 && /verif/i.test(error.message ?? "");
}

interface CredentialHandlers {
  readonly onStart: () => void;
  readonly onSignedIn: () => void;
  readonly onError: (message: string) => void;
  // A sign-in that answered "now the code": the password was right, no session
  // exists yet, and the caller owes a TOTP or backup code (#55). Only sign-in
  // can answer this way, so sign-up does not pass it.
  readonly onTwoFactor?: () => void;
  // The account exists and its address has not been confirmed: a sign-up that
  // minted no session, or a sign-in refused for the same reason (#306). Without
  // this, both were reported as signed in or as a bare failure, and the reader
  // had nowhere to go — there was no resend and nothing naming the inbox.
  readonly onVerificationRequired?: () => void;
}

function credentialCallbacks(handlers: CredentialHandlers) {
  return {
    onMutate: handlers.onStart,
    onSuccess: (result: Answer) => {
      if (result.error !== null) {
        if (needsEmailVerification(result.error) && handlers.onVerificationRequired) {
          handlers.onVerificationRequired();
          return;
        }
        handlers.onError(result.error.message ?? "authentication failed");
      } else if (wantsSecondFactor(result.data)) {
        // Without a handler this would be reported as signed in — and every
        // query would answer 401 behind that lie.
        (handlers.onTwoFactor ?? (() => handlers.onError("two-factor code required")))();
      } else if (!hasSession(result.data)) {
        // The same lie, one endpoint over. A sign-up on an install that requires
        // a verified address answers 200 with no session, and this branch used to
        // fall through to onSignedIn — so the shell mounted, fetched four
        // org-level keys, and every one answered 401 (seen in production, #306).
        (
          handlers.onVerificationRequired ??
          (() => handlers.onError("confirm your email address to continue"))
        )();
      } else {
        handlers.onSignedIn();
      }
    },
    onError: () => handlers.onError("authentication failed"),
  };
}

// The second half of a 2FA sign-in: the code from the authenticator app, or
// one of the backup codes. `trustDevice` asks better-auth to remember this
// browser for 30 days, so the code is for new places rather than every
// morning.
// Which kind of code the reader is about to type. Three, because they come
// from three different places and are verified by three different endpoints:
// the authenticator app, the inbox, and the sheet saved at enrolment.
export type SecondFactorKind = "totp" | "email" | "backup";

export function useVerifySecondFactor(h: CredentialHandlers) {
  return useMutation({
    mutationFn: (attempt: { code: string; kind: SecondFactorKind; trustDevice: boolean }) => {
      const body = { code: attempt.code, trustDevice: attempt.trustDevice };
      if (attempt.kind === "backup") return authClient.twoFactor.verifyBackupCode(body);
      if (attempt.kind === "email") return authClient.twoFactor.verifyOtp(body);
      return authClient.twoFactor.verifyTotp(body);
    },
    ...credentialCallbacks(h),
  });
}

// Ask the api to mail a code. Its own mutation rather than a step inside the
// verify, because the reader waits between the two and the button has to say
// so — and because this is the one that fails on a deployment with no SMTP,
// with a message worth showing verbatim (EMAIL_NOT_CONFIGURED).
export function useSendEmailCode(handlers: {
  onSent: () => void;
  onError: (message: string) => void;
}) {
  return useMutation({
    mutationFn: () => authClient.twoFactor.sendOtp(),
    onSuccess: (result: Answer) => {
      if (result.error === null) handlers.onSent();
      else handlers.onError(result.error.message ?? "could not send the code");
    },
    onError: () => handlers.onError("could not send the code"),
  });
}

// The credentials arrive with mutate(), not with the hook call. They used to
// arrive with the hook call because they lived in the component's useState and
// were therefore current on every render; they now live in a TanStack Form store
// that deliberately does not re-render the component when they change, so a
// closure captured at render would submit whatever was typed before the last
// keystroke. Values belong to the submit, which is when the form hands them over.
export function useSignIn(h: CredentialHandlers) {
  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      authClient.signIn.email(credentials),
    ...credentialCallbacks(h),
  });
}

// Re-send the verification link. The api route existed and was rate-limited from
// the day it shipped (better-auth's own 3-per-minute mail rule, kept deliberately
// in auth/rate-limit.ts); nothing ever called it, so the only resend this product
// had was pressing "sign in" again and not being told that is what happened
// (#306).
//
// This is also the one path on which a failed send is VISIBLE. `sendMail`
// swallows its own failures and returns a boolean nobody reads, but the api's
// hooks.before refuses here with EMAIL_NOT_CONFIGURED when the deployment cannot
// send at all — so a reader pressing this gets the real answer instead of a
// second silent nothing.
export function useResendVerification(h: {
  readonly onStart: () => void;
  readonly onSent: () => void;
  readonly onError: (message: string) => void;
}) {
  return useMutation({
    mutationFn: (email: string) => authClient.sendVerificationEmail({ email }),
    onMutate: h.onStart,
    onSuccess: (result: Answer) => {
      if (result.error !== null) h.onError(result.error.message ?? "could not send the email");
      else h.onSent();
    },
    onError: () => h.onError("could not send the email"),
  });
}

export function useSignUp(h: CredentialHandlers) {
  return useMutation({
    mutationFn: (credentials: { email: string; password: string; name: string }) =>
      authClient.signUp.email(credentials),
    ...credentialCallbacks(h),
  });
}

// Signing in again while already signed in — the answer to SESSION_NOT_FRESH,
// the api's refusal to go live, rotate credentials or disconnect on a session
// older than an hour (#52). Better-auth mints a new session row, which is what
// the api measures freshness from.
//
// The same person, so nothing sweeps the cache — but the new session knows
// nothing of the org switcher, so the active org is carried across by hand:
// left null, a multi-org owner would come back from the password prompt
// silently moved to their oldest org, and the retried action would answer
// NOT_FOUND for a cluster they were just looking at.
//
// With a second factor on the account the password alone mints nothing:
// better-auth answers twoFactorRedirect and the dialog owes a code, which is
// the whole point of having one (#55). The org restore and the invalidations
// then belong to the code's mutation instead — shared below.
interface ReauthHandlers {
  readonly onFresh: () => void;
  readonly onError: (message: string) => void;
  readonly onTwoFactor?: () => void;
}

async function restoreActiveOrg(activeOrgId: string | null): Promise<Answer> {
  if (activeOrgId === null) return { error: null };
  return authClient.organization.setActive({ organizationId: activeOrgId });
}

function reauthCallbacks(handlers: ReauthHandlers, queryClient: ReturnType<typeof useQueryClient>) {
  return {
    onSuccess: async (result: Answer) => {
      if (result.error !== null) {
        handlers.onError(result.error.message ?? "authentication failed");
        return;
      }
      if (wantsSecondFactor(result.data)) {
        (handlers.onTwoFactor ?? (() => handlers.onError("two-factor code required")))();
        return;
      }
      // A new session row: the sessions list gained one and "this device"
      // moved. Same identity, so the org- and cluster-level answers stand.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mySessions() }),
      ]);
      handlers.onFresh();
    },
    onError: () => handlers.onError("authentication failed"),
  };
}

export function useReauthenticate(handlers: ReauthHandlers) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (attempt: {
      email: string;
      password: string;
      activeOrgId: string | null;
    }): Promise<Answer> => {
      const signedIn = await authClient.signIn.email({
        email: attempt.email,
        password: attempt.password,
      });
      if (signedIn.error !== null) return signedIn;
      if (wantsSecondFactor(signedIn.data)) return signedIn;
      return restoreActiveOrg(attempt.activeOrgId);
    },
    ...reauthCallbacks(handlers, queryClient),
  });
}

// The code step of a re-authentication, when the password answered
// twoFactorRedirect. No trustDevice: the fresh-session tier exists to prove
// presence NOW, and a trusted device would let the next re-auth skip the one
// thing it exists to ask.
export function useReauthenticateSecondFactor(handlers: ReauthHandlers) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (attempt: {
      code: string;
      backup: boolean;
      activeOrgId: string | null;
    }): Promise<Answer> => {
      const verified = attempt.backup
        ? await authClient.twoFactor.verifyBackupCode({ code: attempt.code })
        : await authClient.twoFactor.verifyTotp({ code: attempt.code });
      if (verified.error !== null) return verified;
      return restoreActiveOrg(attempt.activeOrgId);
    },
    ...reauthCallbacks(handlers, queryClient),
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => authClient.signOut(),
    // onSettled, not onSuccess: after an attempt at signing out, whether the
    // cookie is gone is the server's answer to give, not ours to assume.
    onSettled: () => invalidateSession(queryClient),
  });
}

// The notice must read the same whether or not the account exists, or the form
// is an account-enumeration oracle. Only a failure the api reported is shown.
export function useRequestPasswordReset(handlers: {
  onStart: () => void;
  onSent: () => void;
  onError: (message: string) => void;
}) {
  return useMutation({
    // Where the emailed link lands. It is this origin because the reset page is
    // this app's, and it is named here rather than fixed server-side — as it
    // was when a server function made this call — because better-auth refuses a
    // redirect target that is not a trusted origin. The check that mattered was
    // never that the client could not say it.
    mutationFn: (email: string) =>
      authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      }),
    onMutate: handlers.onStart,
    onSuccess: (sent: Answer) => {
      if (sent.error === null) handlers.onSent();
      else handlers.onError(sent.error.message ?? "request failed");
    },
    onError: () => handlers.onError("request failed"),
  });
}

// Nothing to invalidate: the reader is not signed in, so there is nothing
// cached about them yet.
// The token comes from the URL rather than the form, so it stays a hook argument;
// only the password the reader typed arrives with mutate().
export function useResetPassword(
  token: string,
  handlers: {
    onStart: () => void;
    onDone: () => void;
    onError: (message: string) => void;
  },
) {
  return useMutation({
    mutationFn: (newPassword: string) => authClient.resetPassword({ token, newPassword }),
    onMutate: handlers.onStart,
    onSuccess: (result: Answer) => {
      if (result.error === null) handlers.onDone();
      else handlers.onError(result.error.message ?? "reset failed");
    },
    onError: () => handlers.onError("reset failed"),
  });
}

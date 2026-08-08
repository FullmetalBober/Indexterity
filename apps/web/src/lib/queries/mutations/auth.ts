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
  readonly error: { readonly message?: string } | null;
}

// A sign-in that answered "now the code" instead of a session (#55).
function wantsSecondFactor(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  );
}

interface CredentialHandlers {
  readonly onStart: () => void;
  readonly onSignedIn: () => void;
  readonly onError: (message: string) => void;
  // A sign-in that answered "now the code": the password was right, no session
  // exists yet, and the caller owes a TOTP or backup code (#55). Only sign-in
  // can answer this way, so sign-up does not pass it.
  readonly onTwoFactor?: () => void;
}

function credentialCallbacks(handlers: CredentialHandlers) {
  return {
    onMutate: handlers.onStart,
    onSuccess: (result: Answer) => {
      if (result.error !== null) {
        handlers.onError(result.error.message ?? "authentication failed");
      } else if (wantsSecondFactor(result.data)) {
        // Without a handler this would be reported as signed in — and every
        // query would answer 401 behind that lie.
        (handlers.onTwoFactor ?? (() => handlers.onError("two-factor code required")))();
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
export function useVerifySecondFactor(h: CredentialHandlers) {
  return useMutation({
    mutationFn: (attempt: { code: string; backup: boolean; trustDevice: boolean }) =>
      attempt.backup
        ? authClient.twoFactor.verifyBackupCode({
            code: attempt.code,
            trustDevice: attempt.trustDevice,
          })
        : authClient.twoFactor.verifyTotp({
            code: attempt.code,
            trustDevice: attempt.trustDevice,
          }),
    ...credentialCallbacks(h),
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

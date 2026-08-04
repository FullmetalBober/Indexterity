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

// better-auth answers with { data, error } rather than throwing, so a refusal
// arrives as a resolved promise and is branched on here. onError underneath is
// what catches the request that got no answer at all.
interface Answer {
  readonly error: { readonly message?: string } | null;
}

interface CredentialHandlers {
  readonly onStart: () => void;
  readonly onSignedIn: () => void;
  readonly onError: (message: string) => void;
}

function credentialCallbacks(handlers: CredentialHandlers) {
  return {
    onMutate: handlers.onStart,
    onSuccess: (result: Answer) => {
      if (result.error === null) handlers.onSignedIn();
      else handlers.onError(result.error.message ?? "authentication failed");
    },
    onError: () => handlers.onError("authentication failed"),
  };
}

export function useSignIn(credentials: { email: string; password: string }, h: CredentialHandlers) {
  return useMutation({
    mutationFn: () => authClient.signIn.email(credentials),
    ...credentialCallbacks(h),
  });
}

export function useSignUp(
  credentials: { email: string; password: string; name: string },
  h: CredentialHandlers,
) {
  return useMutation({
    mutationFn: () => authClient.signUp.email(credentials),
    ...credentialCallbacks(h),
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
export function useRequestPasswordReset(
  email: string,
  handlers: {
    onStart: () => void;
    onSent: () => void;
    onError: (message: string) => void;
  },
) {
  return useMutation({
    // Where the emailed link lands. It is this origin because the reset page is
    // this app's, and it is named here rather than fixed server-side — as it
    // was when a server function made this call — because better-auth refuses a
    // redirect target that is not a trusted origin. The check that mattered was
    // never that the client could not say it.
    mutationFn: () =>
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
export function useResetPassword(
  reset: { token: string; newPassword: string },
  handlers: {
    onStart: () => void;
    onDone: () => void;
    onError: (message: string) => void;
  },
) {
  return useMutation({
    mutationFn: () => authClient.resetPassword(reset),
    onMutate: handlers.onStart,
    onSuccess: (result: Answer) => {
      if (result.error === null) handlers.onDone();
      else handlers.onError(result.error.message ?? "reset failed");
    },
    onError: () => handlers.onError("reset failed"),
  });
}

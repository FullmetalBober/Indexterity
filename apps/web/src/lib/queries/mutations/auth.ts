// Signing in, signing up, signing out, and the two halves of a password reset.
//
// All of these change who is asking, so they invalidate the session rather than
// a key: every cached answer belonged to the previous identity. The one that
// does not is the reset-link request, which changes nothing at all.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { requestPasswordReset, resetPassword, signIn, signOut, signUp } from "../../auth";
import { invalidateSession } from "../client";

interface Answer {
  readonly ok: boolean;
  readonly error: string | null;
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
      if (result.ok) handlers.onSignedIn();
      else handlers.onError(result.error ?? "authentication failed");
    },
    onError: () => handlers.onError("authentication failed"),
  };
}

export function useSignIn(credentials: { email: string; password: string }, h: CredentialHandlers) {
  return useMutation({
    mutationFn: () => signIn({ data: credentials }),
    ...credentialCallbacks(h),
  });
}

export function useSignUp(
  credentials: { email: string; password: string; name: string },
  h: CredentialHandlers,
) {
  return useMutation({
    mutationFn: () => signUp({ data: credentials }),
    ...credentialCallbacks(h),
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => signOut(),
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
    mutationFn: () => requestPasswordReset({ data: email }),
    onMutate: handlers.onStart,
    onSuccess: (sent) => {
      if (sent.ok) handlers.onSent();
      else handlers.onError(sent.error ?? "request failed");
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
    mutationFn: () => resetPassword({ data: reset }),
    onMutate: handlers.onStart,
    onSuccess: (result) => {
      if (result.ok) handlers.onDone();
      else handlers.onError(result.error ?? "reset failed");
    },
    onError: () => handlers.onError("reset failed"),
  });
}

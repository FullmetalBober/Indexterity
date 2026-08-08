// What the account page changes: the display name, the password, and which
// sessions stay open. All better-auth's own endpoints, none of them the api's.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "../../auth-client";
import { apiMessage, unwrap } from "../errors";
import { queryKeys } from "../keys";

// The name is drawn in more places than the profile card: the org page spells
// it out to teammates in the member list. better-auth re-signs the session
// cookie in the same response, so the refetched "me" is already the new name —
// no five-minute cookie-cache shadow here (see the hooks note in the api's
// auth.config.ts for the case that does need one).
export function useUpdateName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => unwrap(authClient.updateUser({ name })),
    onSuccess: async () => {
      toast.success("Name updated");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org() }),
      ]);
    },
    onError: (error) => toast.error(apiMessage(error, "Could not update the name")),
  });
}

// A change of address is a chain, not a write (#83): a verified account's
// current address approves it, then the new one proves itself; an unverified
// account changes at once and the new address gets the verification mail. The
// response cannot say which happened — better-auth answers { status } either
// way, on purpose (a taken address answers the same, so the form is not an
// existence oracle) — so the toast promises only what is true in every case,
// and the refetched "me" shows the flip when it was immediate.
export function useChangeEmail({ onRequested }: { onRequested: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (newEmail: string) =>
      unwrap(authClient.changeEmail({ newEmail, callbackURL: "/app/account" })),
    onSuccess: async () => {
      toast.success("Change requested — the emails say what happens next");
      onRequested();
      await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
    },
    // 400s carry better-auth's own reasons ("Email is the same", a stale
    // session's demand to sign in again); 403 is the signup gate's refusal,
    // which names the rule.
    onError: (error) => toast.error(apiMessage(error, "Could not change the email")),
  });
}

// onDone exists so the form can clear itself: a password that succeeded has no
// business still sitting in three text fields.
export function useChangePassword({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions: boolean;
    }) => unwrap(authClient.changePassword(change)),
    onSuccess: async () => {
      toast.success("Password changed");
      onDone();
      // Revoking the others rotates THIS session's token server-side too, so
      // both reads are wrong: the list holds dead sessions, and "me" holds the
      // retired token — which is what the list marks the current row against.
      // Stale, the one session left would wear a Revoke button instead of
      // "this device".
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mySessions() }),
      ]);
    },
    // 400 carries better-auth's own reason — a wrong current password says so,
    // and "failed" would send the reader off to reset a password they know.
    onError: (error) => toast.error(apiMessage(error, "Password change failed")),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => unwrap(authClient.revokeSession({ token })),
    onSuccess: () => {
      toast.success("Session revoked");
      return queryClient.invalidateQueries({ queryKey: queryKeys.mySessions() });
    },
    onError: (error) => toast.error(apiMessage(error, "Could not revoke that session")),
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(authClient.revokeOtherSessions()),
    onSuccess: () => {
      toast.success("Signed out everywhere else");
      return queryClient.invalidateQueries({ queryKey: queryKeys.mySessions() });
    },
    onError: (error) => toast.error(apiMessage(error, "Could not sign out the other sessions")),
  });
}

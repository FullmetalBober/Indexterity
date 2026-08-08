// Enrolling, proving, disabling and re-keying the second factor (#55) — all
// better-auth's own endpoints, all password-guarded server-side, which is why
// every hook here takes one.
//
// The secrets flow THROUGH these hooks and never into the cache: the TOTP URI
// and the backup codes go to the component's local state, are shown once, and
// are gone with it. What the cache learns is only the flag on "me".
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "../../auth-client";
import { apiMessage, unwrap } from "../errors";
import { queryKeys } from "../keys";

export interface IssuedTwoFactor {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

// Step one: the password buys a secret and the codes. Nothing is on yet —
// `twoFactorEnabled` flips when the first code verifies, so a reader who
// closes the page here has enrolled nothing and lost nothing.
export function useEnableTwoFactor({ onIssued }: { onIssued: (issued: IssuedTwoFactor) => void }) {
  return useMutation({
    mutationFn: (password: string) => unwrap(authClient.twoFactor.enable({ password })),
    onSuccess: (issued) => onIssued({ totpURI: issued.totpURI, backupCodes: issued.backupCodes }),
    // 400 is better-auth's own wording — a wrong password says so.
    onError: (error) => toast.error(apiMessage(error, "Could not start two-factor setup")),
  });
}

// Step two: the first code from the app. This is the moment the account is
// actually protected — and the moment the api's owner gate stops refusing,
// so "me" has to learn the flag.
export function useVerifyTwoFactorEnrolment({ onVerified }: { onVerified: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => unwrap(authClient.twoFactor.verifyTotp({ code })),
    onSuccess: async () => {
      toast.success("Two-factor authentication is on");
      await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
      onVerified();
    },
    onError: (error) => toast.error(apiMessage(error, "That code did not verify")),
  });
}

export function useDisableTwoFactor({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => unwrap(authClient.twoFactor.disable({ password })),
    onSuccess: async () => {
      toast.success("Two-factor authentication is off");
      await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
      onDone();
    },
    onError: (error) => toast.error(apiMessage(error, "Could not turn two-factor off")),
  });
}

// New codes, old codes dead — for the reader who spent some, or lost the
// sheet. Shown once, same as at enrolment.
export function useRegenerateBackupCodes({
  onIssued,
}: {
  onIssued: (codes: readonly string[]) => void;
}) {
  return useMutation({
    mutationFn: (password: string) =>
      unwrap(authClient.twoFactor.generateBackupCodes({ password })),
    onSuccess: (result) => onIssued(result.backupCodes),
    onError: (error) => toast.error(apiMessage(error, "Could not regenerate the codes")),
  });
}

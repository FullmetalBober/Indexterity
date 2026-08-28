import { apiEnv } from "../config/env";

// Who may create an account.
//   invite  — the default. The FIRST account is always allowed (someone has to
//             bootstrap the install); after that an address needs a pending,
//             unexpired invite. Note this gates ACCOUNT CREATION only: joining
//             an org still requires being signed in AS the invited address, so
//             knowing one buys nothing.
//   open    — anyone (development, or a deliberately public instance).
//   closed  — nobody new, not even the first user.
export type SignupMode = "invite" | "open" | "closed";

export function signupMode(): SignupMode {
  return apiEnv().SIGNUP_MODE;
}

export interface SignupDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export const ALLOWED: SignupDecision = { allowed: true, reason: "" };

// Pure enough to unit-test: the caller supplies the two facts a decision needs.
export function decideSignup(
  mode: SignupMode,
  facts: { readonly isFirstUser: boolean; readonly hasPendingInvite: boolean },
): SignupDecision {
  if (mode === "open") return ALLOWED;
  if (mode === "closed") {
    return { allowed: false, reason: "sign-up is disabled on this instance" };
  }
  if (facts.isFirstUser || facts.hasPendingInvite) return ALLOWED;
  return {
    allowed: false,
    reason: "sign-up is invite-only — ask an owner to invite this email address",
  };
}

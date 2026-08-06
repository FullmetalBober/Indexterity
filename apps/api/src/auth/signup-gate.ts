import { and, type Database, eq, gt, invites, sql, user } from "../db";

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
  const raw = process.env.SIGNUP_MODE;
  if (raw === "open" || raw === "closed") return raw;
  return "invite";
}

export interface SignupDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

const ALLOWED: SignupDecision = { allowed: true, reason: "" };

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

export async function evaluateSignup(db: Database, email: string): Promise<SignupDecision> {
  const mode = signupMode();
  if (mode === "open") return ALLOWED;
  const [existing] = await db.select({ total: sql<number>`count(*)::int` }).from(user);
  const isFirstUser = (existing?.total ?? 0) === 0;
  if (mode === "closed") return decideSignup(mode, { isFirstUser, hasPendingInvite: false });
  const [pending] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.email, email.toLowerCase()),
        eq(invites.status, "pending"),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return decideSignup(mode, { isFirstUser, hasPendingInvite: pending !== undefined });
}

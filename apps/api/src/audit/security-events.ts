import type { Database } from "../db";
import { securityEvents } from "../db";

// Who did what, to whom, from where — for the acts that are not index operations.
//
// `actions` covers the pipeline: every hide, drop, build and rollback, with its
// actor and its rollback token. This covers the rest of what an incident asks
// about, which had no trail at all (#53): sign-ins, the org's membership, and the
// four things that can be done to a cluster's access.

// Written to `security_events.event`. Adding one is a constant here, not a
// migration — the column is text.
export const SECURITY_EVENTS = [
  // Authentication.
  "ACCOUNT_CREATED",
  "SIGN_IN",
  "SIGN_IN_FAILED",
  "SIGN_OUT",
  "SESSION_REVOKED",
  // The second factor (#55). VERIFIED/FAILED cover both moments a code is
  // asked for — completing a sign-in and proving an enrolment — because the
  // path cannot tell them apart and both are worth a row: a run of FAILED is
  // someone guessing at a code, whichever door they are guessing at.
  "TWO_FACTOR_ENABLED",
  "TWO_FACTOR_DISABLED",
  "TWO_FACTOR_VERIFIED",
  "TWO_FACTOR_FAILED",
  "TWO_FACTOR_CODES_REGENERATED",
  // Membership. The acts that decide who can do everything else.
  "MEMBER_ROLE_CHANGED",
  "MEMBER_REMOVED",
  "MEMBER_LEFT",
  "INVITE_CREATED",
  "INVITE_ACCEPTED",
  "ORG_CREATED",
  "ORG_DELETED",
  // A cluster's access, which is what the control plane holds of a customer's.
  "CLUSTER_CONNECTED",
  "CLUSTER_DISCONNECTED",
  "CLUSTER_CREDENTIALS_ROTATED",
  "CLUSTER_MODE_CHANGED",
] as const;

export type SecurityEventName = (typeof SECURITY_EVENTS)[number];

export interface SecurityEventInput {
  readonly event: SecurityEventName;
  readonly orgId?: string | null;
  readonly clusterId?: string | null;
  readonly actorUserId?: string | null;
  readonly actorEmail?: string | null;
  readonly target?: string | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

// Where the client came from, as far as this deployment can honestly tell.
//
// Both readers are header-only: better-auth is handed a synthetic Request built
// from Fastify's parsed one (main.ts), so there is no socket to fall back to, and
// the api's own handlers use Fastify's already-resolved `request.ip`.
//
// The leftmost X-Forwarded-For entry is the client as the first proxy saw it, and
// it is only read when the deployment says a proxy is in front — otherwise a
// client sets its own and the trail records whatever it fancied. Pure, so the
// choice is testable without a request.
export function clientFromHeaders(
  headers: Headers | undefined,
  trustProxy: boolean,
): { ipAddress: string | null; userAgent: string | null } {
  const userAgent = headers?.get("user-agent") ?? null;
  if (!trustProxy) return { ipAddress: null, userAgent };
  const forwarded = headers?.get("x-forwarded-for") ?? "";
  const client = forwarded.split(",")[0]?.trim() ?? "";
  return { ipAddress: client === "" ? null : client, userAgent };
}

// Which act a better-auth route amounts to, or null for one that is not an act.
//
// Pure and exported so the mapping is a unit test rather than something only an
// integration run can check. `ok` is whether the endpoint answered rather than
// refused: a sign-in that failed is the interesting half of a sign-in, and every
// other path here is only worth a row when it actually happened.
//
// Paths are better-auth's, relative to its base — the same strings its own
// rate-limit rules match on.
export function authEventFor(path: string, ok: boolean): SecurityEventName | null {
  if (path.startsWith("/sign-in")) return ok ? "SIGN_IN" : "SIGN_IN_FAILED";
  // Before the ok-gate: a wrong code is the interesting half, same as a wrong
  // password. TOTP and backup code land on the same pair — which kind is in
  // the path, and the path is stored on the row.
  if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code") {
    return ok ? "TWO_FACTOR_VERIFIED" : "TWO_FACTOR_FAILED";
  }
  if (!ok) return null;
  if (path === "/two-factor/enable") return "TWO_FACTOR_ENABLED";
  if (path === "/two-factor/disable") return "TWO_FACTOR_DISABLED";
  if (path === "/two-factor/generate-backup-codes") return "TWO_FACTOR_CODES_REGENERATED";
  // Not in the issue's list, and it belongs there: a sign-up creates a session
  // without a sign-in, so without this the first session an account ever holds
  // would be the one with no row explaining where it came from. The refusal side
  // is already covered — SIGNUP_MODE turning someone away is a 403 from the
  // signup gate, not an account.
  if (path.startsWith("/sign-up")) return "ACCOUNT_CREATED";
  if (path === "/sign-out") return "SIGN_OUT";
  if (path.startsWith("/revoke-session")) return "SESSION_REVOKED";
  if (path === "/revoke-other-sessions") return "SESSION_REVOKED";
  if (path === "/organization/create") return "ORG_CREATED";
  if (path === "/organization/delete") return "ORG_DELETED";
  if (path === "/organization/update-member-role") return "MEMBER_ROLE_CHANGED";
  if (path === "/organization/remove-member") return "MEMBER_REMOVED";
  if (path === "/organization/leave") return "MEMBER_LEFT";
  if (path === "/organization/invite-member") return "INVITE_CREATED";
  if (path === "/organization/accept-invitation") return "INVITE_ACCEPTED";
  return null;
}

// Best-effort on purpose, and logged when it fails.
//
// The alternative — letting a failed insert fail the request — would mean a
// momentary problem with this table could stop people signing in, and refusing
// the sign-in does not un-record it either: the act already happened. So the row
// is attempted after the act, and a loss is reported rather than escalated. The
// same trade `storeCluster` makes for the first collect, and for the same reason.
export async function recordSecurityEvent(
  db: Database,
  input: SecurityEventInput,
  warn: (message: string) => void = () => {},
): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      event: input.event,
      orgId: input.orgId ?? null,
      clusterId: input.clusterId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      target: input.target ?? null,
      metadata: input.metadata ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (error) {
    warn(
      `could not record the security event ${input.event}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

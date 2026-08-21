import { ORPCError } from "@orpc/server";
import type { Database } from "../db";
import { eq, orgPolicies } from "../db";
import type { ConnectionDiagnosis } from "../engine/ports";

// The org-level rule that credentials broader than the engine needs are not
// stored at all (#313), and the two doors it is checked at.
//
// D15 says the admin string is used once and never discarded — that is what turns
// "we cannot read your documents" from a promise into something the server
// enforces. It was only ever true of the provisioning path. The button beside it,
// "Use these credentials as-is", is one click cheaper and seals whatever was
// pasted, so an org that had decided least privilege was mandatory enforced it by
// asking colleagues nicely. This is the setting that makes it a property of the
// install instead.
//
// Off by default and deliberately not retroactive: see the table's comment in
// db/schema.ts.

export interface OrgPolicy {
  readonly requireLeastPrivilege: boolean;
  // Null until an owner saves one, which is what tells "off" apart from "never
  // configured" — the distinction #258 found the per-cluster toggle lacked.
  readonly updatedAt: Date | null;
}

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  requireLeastPrivilege: false,
  updatedAt: null,
};

// The org's policy, or the defaults when it has never saved one. Absent row and
// "all defaults" are the same answer to every caller except the settings screen,
// which reads `updatedAt` to say which it is.
export async function orgPolicyFor(db: Database, orgId: string): Promise<OrgPolicy> {
  const [row] = await db.select().from(orgPolicies).where(eq(orgPolicies.orgId, orgId)).limit(1);
  if (row === undefined) return DEFAULT_ORG_POLICY;
  return { requireLeastPrivilege: row.requireLeastPrivilege, updatedAt: row.updatedAt };
}

// Why a diagnosis fails the rule, or null when it passes. Pure, so the wording
// is testable without a cluster — and it is worth pinning, because this sentence
// is the entire remedy a refused reader gets.
//
// Two shapes of failure, and the second is not a narrower version of the first:
//
//  - `canProvision` — these credentials can create users or roles. The product
//    has a better path for exactly this string and it is one button along, so the
//    refusal names it.
//  - `authEnabled === false` — a deployment with authentication turned off. It
//    holds every privilege there is and cannot be narrowed by any grant, so
//    provisioning is not the answer either: there is nothing to authenticate a
//    scoped user AS. Refused rather than exempted, which is the decision the
//    issue left open. An exemption would mean an org that has switched this on
//    still stores the broadest credential this product can hold, which is the
//    opposite of what it asked for — and the connect form deliberately stays
//    quiet about provisioning in that case, so an exemption would also be silent.
export function leastPrivilegeRefusal(diagnosis: {
  readonly canProvision: boolean;
  readonly authEnabled: boolean;
}): string | null {
  if (!diagnosis.authEnabled) {
    return (
      "this organization requires least-privilege credentials, and this deployment has " +
      "authentication disabled — it grants every privilege to anyone who can reach it, and no " +
      "grant can narrow that. Enable authentication on the server and connect as a user that " +
      "cannot create users."
    );
  }
  if (diagnosis.canProvision) {
    return (
      "this organization requires least-privilege credentials, and these can create users or " +
      "roles. Let Indexterity provision a scoped user from this string instead — the string is " +
      "used once and never stored — or connect as a user that already has only what the engine " +
      "needs."
    );
  }
  return null;
}

// The gate itself, at both doors. Raised as LEAST_PRIVILEGE/422 rather than 400:
// the request is well formed and the string works, and what is wrong with it is a
// rule this org set rather than a mistake in what was typed. The dashboard reads
// the message, so the remedy above reaches the reader verbatim.
export async function assertLeastPrivilege(
  db: Database,
  orgId: string,
  diagnosis: Pick<ConnectionDiagnosis, "canProvision" | "authEnabled">,
): Promise<void> {
  const policy = await orgPolicyFor(db, orgId);
  if (!policy.requireLeastPrivilege) return;
  const refusal = leastPrivilegeRefusal(diagnosis);
  if (refusal === null) return;
  throw new ORPCError("LEAST_PRIVILEGE", { status: 422, message: refusal });
}

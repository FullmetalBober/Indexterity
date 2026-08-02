// What each plan allows. Pure — no database, no provider, no I/O — so the
// rules can be read in one place and tested without either.
//
// Deliberately provider-agnostic. Whoever ends up taking the money (an invoice
// you send by hand, Paddle, Polar, Stripe) only ever decides WHICH plan an org
// is on; what that plan permits is this file and nothing else. Adding a
// provider later means writing the org's plan on a webhook, not touching any of
// the enforcement below.

export const PLANS = ["FREE", "PRO", "SCALE"] as const;
export type Plan = (typeof PLANS)[number];

export const DEFAULT_PLAN: Plan = "FREE";

export function isPlan(value: string): value is Plan {
  return PLANS.some((plan) => plan === value);
}

export interface Entitlements {
  // Connected clusters. The primary meter: it tracks the value delivered and
  // the cost of delivering it, and it is the one number a customer can predict.
  readonly maxClusters: number;
  // People in the org. Generous — charging per seat on a tool one DBA operates
  // punishes exactly the teams who would share the audit trail.
  readonly maxMembers: number;
  // The create side (workloadAnalysis). Dropping unused indexes is the core
  // promise and stays free; proposing new ones reads the query workload, which
  // is the heavier and more advanced half.
  readonly workloadAnalysis: boolean;
  // How much history the time-series tables keep for this org, in days. Longer
  // history is what makes a usage claim trustworthy — see analysis/classify.ts.
  readonly retentionDays: number;
}

// One table. Change a number here and every gate follows.
const ENTITLEMENTS: Record<Plan, Entitlements> = {
  FREE: { maxClusters: 1, maxMembers: 3, workloadAnalysis: false, retentionDays: 30 },
  PRO: { maxClusters: 5, maxMembers: 15, workloadAnalysis: true, retentionDays: 90 },
  SCALE: {
    maxClusters: Number.POSITIVE_INFINITY,
    maxMembers: Number.POSITIVE_INFINITY,
    workloadAnalysis: true,
    retentionDays: 365,
  },
};

export function entitlementsFor(plan: Plan): Entitlements {
  return ENTITLEMENTS[plan];
}

// An unrecognised stored value must not silently grant everything. Falls back
// to the most restrictive plan, which fails visibly rather than expensively.
export function planFrom(value: string | null | undefined): Plan {
  return value !== null && value !== undefined && isPlan(value) ? value : DEFAULT_PLAN;
}

export interface LimitVerdict {
  readonly allowed: boolean;
  // Null when allowed. Names the limit, the plan, and what to do — a bare
  // "forbidden" leaves the reader guessing whether it is a bug or a bill.
  readonly reason: string | null;
}

const ALLOWED: LimitVerdict = { allowed: true, reason: null };

function describe(limit: number): string {
  return Number.isFinite(limit) ? String(limit) : "unlimited";
}

// Adding one more of something the plan caps. `current` is what already exists.
export function withinLimit(
  plan: Plan,
  what: "clusters" | "members",
  current: number,
): LimitVerdict {
  const limit =
    what === "clusters" ? entitlementsFor(plan).maxClusters : entitlementsFor(plan).maxMembers;
  if (current < limit) return ALLOWED;
  return {
    allowed: false,
    reason:
      `the ${plan} plan allows ${describe(limit)} ${what} and this organization has ${current}. ` +
      `Remove one, or move to a plan with room for more.`,
  };
}

export function allowsWorkloadAnalysis(plan: Plan): LimitVerdict {
  if (entitlementsFor(plan).workloadAnalysis) return ALLOWED;
  return {
    allowed: false,
    reason:
      `workload analysis proposes new indexes from your query shapes, and the ${plan} plan ` +
      `does not include it. Dropping unused and redundant indexes is unaffected.`,
  };
}

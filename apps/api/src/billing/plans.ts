// What each plan allows. Pure — no database, no provider, no I/O — so the
// rules can be read in one place and tested without either.
//
// Deliberately provider-agnostic. Whoever ends up taking the money (an invoice
// you send by hand, Paddle, Polar, Stripe) only ever decides WHICH plan an org
// is on; what that plan permits is this file and nothing else. Adding a
// provider later means writing the org's plan on a webhook, not touching any of
// the enforcement below.

export const PLANS = ["FREE", "PRO", "SCALE", "SELF_HOSTED"] as const;
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
  //
  // Counted as members PLUS outstanding invites, which is why the plugin's own
  // `membershipLimit` is left unset: it counts members only, so an org could
  // invite past its plan and spend the seat on whoever clicked the link. One
  // limit with one name — see TenancyService.requireRoomFor.
  readonly maxMembers: number;
  // The create side (workloadAnalysis) — proposing new indexes from the query
  // workload. Free: knowing what to do is the part that makes the tool worth
  // trying, and a recommendation nobody can see sells nothing.
  readonly workloadAnalysis: boolean;
  // Whether the engine may act without a human: autoApplyScore (approve by
  // score) and instantCreate (build a critical missing index immediately).
  //
  // This is the paid line. Every plan sees every recommendation and can apply
  // any of them by hand; what you buy is not having to. The safety pipeline —
  // hide, observe, regression-gate, roll back — is what makes unattended
  // changes safe to run, and it is the hard part.
  readonly autoApply: boolean;
  // How much history the time-series tables keep for this org, in days. Longer
  // history is what makes a usage claim trustworthy — see analysis/classify.ts.
  readonly retentionDays: number;
}

// One table. Change a number here and every gate follows.
const ENTITLEMENTS: Record<Plan, Entitlements> = {
  FREE: {
    maxClusters: 1,
    maxMembers: 3,
    workloadAnalysis: true,
    autoApply: false,
    retentionDays: 90,
  },
  PRO: {
    maxClusters: 5,
    maxMembers: 15,
    workloadAnalysis: true,
    autoApply: true,
    retentionDays: 183,
  },
  SCALE: {
    maxClusters: Number.POSITIVE_INFINITY,
    maxMembers: Number.POSITIVE_INFINITY,
    workloadAnalysis: true,
    autoApply: true,
    retentionDays: 365,
  },
  // Not a tier anyone buys — it is the BUSL Additional Use Grant expressed as
  // entitlements, and what the Helm chart ships.
  //
  // The licence caps one thing: production clusters. It says nothing about
  // features, seats or history, so neither does this. Shipping self-hosters the
  // hosted FREE tier would restrict them further than the licence they are
  // complying with, which is not a limit — it is a nudge, and an unfair one on
  // hardware they are paying for themselves.
  SELF_HOSTED: {
    maxClusters: 1,
    maxMembers: Number.POSITIVE_INFINITY,
    workloadAnalysis: true,
    autoApply: true,
    retentionDays: 365,
  },
};

// RETENTION_DAYS is the operator's ceiling, not the plan's number. Storage is the
// operator's bill, so they can cap it; a plan may keep less than the cap but never
// more. Unset means the plan decides on its own.
export function operatorCeilingDays(): number {
  const envDays = Number(process.env.RETENTION_DAYS);
  return Number.isFinite(envDays) && envDays > 0 ? envDays : Number.POSITIVE_INFINITY;
}

// How much history a plan may SEE. Applied at every read of the time-series
// tables (jobs/plan.ts → historyWindow), because history depth is the thing a
// paid plan buys: a longer series is what lets the engine call an index unused at
// all, so it has to be enforced rather than advertised.
export function effectiveRetentionDays(plan: Plan): number {
  return Math.min(entitlementsFor(plan).retentionDays, operatorCeilingDays());
}

// How long rows are actually KEPT, for every org on the deployment.
//
// One number, not one per plan, and that is the point. Physical deletion used to
// run a different cutoff per plan, which meant deleting individual rows scattered
// through the table; visibility is a read filter now, so the only thing deletion
// has to guarantee is that nobody can be entitled to a row that is gone. The
// longest any plan may see satisfies that for all of them at once, and it lets a
// deployment prune by dropping whole time ranges instead of hunting rows.
//
// It also means an upgrade returns the customer's history immediately, rather
// than their having to wait out the new window to accumulate it — the rows were
// there all along, merely out of view. Cheap because of run-length storage: an
// idle index is one row whether it is kept for ninety days or a year.
export function maxRetentionDays(): number {
  const longest = Math.max(...PLANS.map((plan) => entitlementsFor(plan).retentionDays));
  return Math.min(longest, operatorCeilingDays());
}

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

// The meters a plan caps. Both are per ORG — how many organizations a person
// holds is not one of them, deliberately: a plan is bought per org, so capping
// how many you may make would be capping how much you may buy.
export type Meter = "clusters" | "members";

const METERS: Record<Meter, (entitlements: Entitlements) => number> = {
  clusters: (entitlements) => entitlements.maxClusters,
  members: (entitlements) => entitlements.maxMembers,
};

export function limitFor(plan: Plan, what: Meter): number {
  return METERS[what](entitlementsFor(plan));
}

// Adding one more of something the plan caps. `current` is what already exists.
export function withinLimit(plan: Plan, what: Meter, current: number): LimitVerdict {
  const limit = limitFor(plan, what);
  if (current < limit) return ALLOWED;
  return {
    allowed: false,
    reason:
      `the ${plan} plan allows ${describe(limit)} ${what} and this organization has ${current}. ` +
      `Remove one, or move to a plan with room for more.`,
  };
}

// autoApplyScore and instantCreate together — refusing them needs one answer,
// because a policy save can set both at once.
export function allowsAutoApply(plan: Plan): LimitVerdict {
  if (entitlementsFor(plan).autoApply) return ALLOWED;
  return {
    allowed: false,
    reason:
      `applying changes without approval is not part of the ${plan} plan. Every recommendation ` +
      `is still made, and you can approve any of them yourself — what a paid plan adds is the ` +
      `engine doing it unattended.`,
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

// The plan a newly created org lands on.
//
// Nothing here is a security control: anyone who owns the database can lift a
// quota with one UPDATE, and the source is public. The licence is what binds —
// BUSL permits production use with one connected cluster — and this is what
// keeps the software honest about it, so a self-hosted install does not quietly
// invite you past what you were granted.
//
// FREE by default because a process that has not been told where it runs should
// offer the least. The chart says SELF_HOSTED, which is what the licence grants
// someone running it on their own hardware.
export function defaultOrgPlan(): Plan {
  return planFrom(process.env.DEFAULT_ORG_PLAN);
}

// What a cluster's policy actually means once the plan is applied.
//
// The stored policy is what an owner asked for; this is what the engine obeys.
// They diverge when a plan changes under a cluster — an org that set an
// auto-approve score on PRO and then moved to FREE must stop approving by
// itself, and clearing the stored value instead would silently lose the
// setting they would get back on upgrading.
export interface PolicyAutomation {
  readonly autoApplyScore: number | null;
  readonly instantCreate: boolean;
}

export function entitledAutomation(policy: PolicyAutomation, plan: Plan): PolicyAutomation {
  if (entitlementsFor(plan).autoApply) return policy;
  return { autoApplyScore: null, instantCreate: false };
}

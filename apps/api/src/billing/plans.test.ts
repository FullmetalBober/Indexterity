import { describe, expect, it } from "vitest";
import {
  allowsAutoApply,
  allowsWorkloadAnalysis,
  DEFAULT_PLAN,
  effectiveRetentionDays,
  entitledAutomation,
  entitlementsFor,
  isPlan,
  maxRetentionDays,
  PLANS,
  type Plan,
  planFrom,
  withinLimit,
} from "./plans";

describe("planFrom", () => {
  it("reads the plans it knows", () => {
    for (const plan of PLANS) expect(planFrom(plan)).toBe(plan);
  });

  // A typo in the column, a plan renamed in a later release, a row written by
  // an older version — none of those may hand out an unlimited account.
  it("falls back to the most restrictive plan for anything else", () => {
    for (const value of [null, undefined, "", "pro", "ENTERPRISE", "SCALE "]) {
      expect(planFrom(value)).toBe(DEFAULT_PLAN);
    }
    expect(entitlementsFor(planFrom("nonsense")).maxClusters).toBe(1);
  });

  it("isPlan is exact", () => {
    expect(isPlan("PRO")).toBe(true);
    expect(isPlan("pro")).toBe(false);
  });
});

describe("withinLimit", () => {
  it("allows up to the cap and refuses at it", () => {
    expect(withinLimit("FREE", "clusters", 0).allowed).toBe(true);
    expect(withinLimit("FREE", "clusters", 1).allowed).toBe(false);
    expect(withinLimit("PRO", "clusters", 4).allowed).toBe(true);
    expect(withinLimit("PRO", "clusters", 5).allowed).toBe(false);
  });

  it("never caps the top plan", () => {
    expect(withinLimit("SCALE", "clusters", 10_000).allowed).toBe(true);
    expect(withinLimit("SCALE", "members", 10_000).allowed).toBe(true);
  });

  // The refusal is read by someone deciding whether they hit a bug or a bill.
  it("names the plan, the limit and what to do", () => {
    const verdict = withinLimit("FREE", "clusters", 1);
    expect(verdict.reason).toContain("FREE");
    expect(verdict.reason).toContain("1 clusters");
    expect(verdict.reason).toContain("plan with room");
  });

  it("says unlimited rather than printing Infinity", () => {
    // Only reachable if a cap is later removed from a lower plan, but a number
    // no reader recognises is worse than none.
    expect(withinLimit("SCALE", "members", 0).reason).toBeNull();
    expect(JSON.stringify(entitlementsFor("SCALE").maxMembers)).toBe("null");
  });

  it("counts members separately from clusters", () => {
    expect(withinLimit("FREE", "members", 2).allowed).toBe(true);
    expect(withinLimit("FREE", "members", 3).allowed).toBe(false);
  });
});

// Seeing what to do is free on every plan — a recommendation nobody can see
// sells nothing. What is paid is the engine acting on it unattended.
describe("what free includes", () => {
  it("gives away the analysis, including index suggestions", () => {
    const free = entitlementsFor("FREE");
    expect(free.workloadAnalysis).toBe(true);
    expect(free.retentionDays).toBe(90);
    for (const plan of PLANS) {
      expect(allowsWorkloadAnalysis(plan).allowed).toBe(true);
    }
  });

  it("sells the automation, not the insight", () => {
    expect(entitlementsFor("FREE").autoApply).toBe(false);
    expect(allowsAutoApply("FREE").allowed).toBe(false);
    expect(allowsAutoApply("PRO").allowed).toBe(true);
    expect(allowsAutoApply("SCALE").allowed).toBe(true);
  });

  // The refusal must not read as "your recommendations are gated too".
  it("says the recommendations still arrive and can be approved by hand", () => {
    const reason = allowsAutoApply("FREE").reason ?? "";
    expect(reason).toContain("approve any of them yourself");
    expect(reason).toContain("unattended");
  });
});

// Not a tier anyone buys: the BUSL grant expressed as entitlements. The licence
// caps production clusters and nothing else, so neither does this.
describe("SELF_HOSTED", () => {
  it("matches the licence — one cluster, everything else on", () => {
    const self = entitlementsFor("SELF_HOSTED");
    expect(self.maxClusters).toBe(1);
    expect(self.workloadAnalysis).toBe(true);
    expect(self.autoApply).toBe(true);
    expect(self.maxMembers).toBe(Number.POSITIVE_INFINITY);
  });

  // Restricting a self-hoster further than the licence does would be a nudge,
  // not a limit — on hardware they pay for themselves.
  it("is never more restrictive than the hosted free tier", () => {
    const self = entitlementsFor("SELF_HOSTED");
    const free = entitlementsFor("FREE");
    expect(self.maxClusters).toBeGreaterThanOrEqual(free.maxClusters);
    expect(self.maxMembers).toBeGreaterThanOrEqual(free.maxMembers);
    expect(self.retentionDays).toBeGreaterThanOrEqual(free.retentionDays);
    expect(Number(self.autoApply)).toBeGreaterThanOrEqual(Number(free.autoApply));
  });
});

// The stored policy is what an owner asked for; this is what the engine obeys.
describe("entitledAutomation", () => {
  const asked = { autoApplyScore: 70, instantCreate: true };

  it("passes a paid plan's policy through untouched", () => {
    expect(entitledAutomation(asked, "PRO")).toEqual(asked);
    expect(entitledAutomation(asked, "SELF_HOSTED")).toEqual(asked);
  });

  // The case the job-level check exists for: set on PRO, then downgraded.
  it("stops the engine acting on a plan that no longer allows it", () => {
    expect(entitledAutomation(asked, "FREE")).toEqual({
      autoApplyScore: null,
      instantCreate: false,
    });
  });
});

describe("entitlements", () => {
  it("never shrinks as the paid tiers grow", () => {
    const order: Plan[] = ["FREE", "PRO", "SCALE"];
    for (let i = 1; i < order.length; i++) {
      const lower = entitlementsFor(order[i - 1] ?? "FREE");
      const higher = entitlementsFor(order[i] ?? "FREE");
      expect(higher.maxClusters).toBeGreaterThanOrEqual(lower.maxClusters);
      expect(higher.maxMembers).toBeGreaterThanOrEqual(lower.maxMembers);
      expect(higher.retentionDays).toBeGreaterThanOrEqual(lower.retentionDays);
      expect(Number(higher.workloadAnalysis)).toBeGreaterThanOrEqual(
        Number(lower.workloadAnalysis),
      );
    }
  });
});

// Half a year on PRO: long enough for a quarterly job to show up twice, which
// is what makes "this index is only used at quarter end" provable rather than
// a guess.
//
// The operator's ceiling is an argument now, not a read of RETENTION_DAYS —
// this file promises to be pure, and config/schema.test.ts is where the variable
// itself is pinned. NO_CEILING is what an unset one means.
const NO_CEILING = Number.POSITIVE_INFINITY;

describe("retention", () => {
  it("gives PRO half a year", () => {
    expect(entitlementsFor("PRO").retentionDays).toBe(183);
  });

  // Two questions with different answers now: how much a plan may SEE, and how
  // long rows are actually KEPT. Deletion runs one cutoff for the whole
  // deployment so it can sweep a contiguous range; the plan's own window is
  // applied on every read instead (jobs/plan.ts).
  it("keeps rows for the longest window any plan could claim", () => {
    const longest = Math.max(...PLANS.map((plan) => entitlementsFor(plan).retentionDays));
    expect(maxRetentionDays(NO_CEILING)).toBe(longest);
    // And nobody can be entitled to a row that has been deleted — the whole
    // safety property of splitting the two.
    for (const plan of PLANS) {
      expect(effectiveRetentionDays(plan, NO_CEILING)).toBeLessThanOrEqual(
        maxRetentionDays(NO_CEILING),
      );
    }
  });

  it("lets the operator's ceiling cap both halves", () => {
    // Storage is the operator's bill, so RETENTION_DAYS caps what is kept AND
    // what any plan may see. A ceiling that capped only visibility would keep
    // paying for rows nobody may read.
    expect(maxRetentionDays(30)).toBe(30);
    expect(effectiveRetentionDays("SCALE", 30)).toBe(30);
    expect(effectiveRetentionDays("FREE", 30)).toBe(30);
  });

  it("ignores a ceiling above the plans, rather than extending them", () => {
    expect(maxRetentionDays(10_000)).toBe(365);
    expect(effectiveRetentionDays("FREE", 10_000)).toBe(90);
  });
});

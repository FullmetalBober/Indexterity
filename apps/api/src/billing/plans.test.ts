import { describe, expect, it } from "vitest";
import {
  allowsWorkloadAnalysis,
  DEFAULT_PLAN,
  entitlementsFor,
  isPlan,
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

describe("allowsWorkloadAnalysis", () => {
  it("is a paid feature", () => {
    expect(allowsWorkloadAnalysis("FREE").allowed).toBe(false);
    expect(allowsWorkloadAnalysis("PRO").allowed).toBe(true);
    expect(allowsWorkloadAnalysis("SCALE").allowed).toBe(true);
  });

  // Gating the create side must not read as gating safety. Dropping is the
  // core promise and stays free on every plan.
  it("says plainly that dropping is unaffected", () => {
    expect(allowsWorkloadAnalysis("FREE").reason).toContain("Dropping");
  });
});

describe("entitlements", () => {
  it("never shrinks as the plan grows", () => {
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

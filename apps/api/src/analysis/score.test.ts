import { describe, expect, it } from "vitest";
import {
  createScore,
  crowdingPenalty,
  dropScore,
  narrowScore,
  RECOMMENDED_AUTO_APPLY_SCORE,
  regressionWeight,
  thinEvidencePenalty,
} from "./score";

describe("dropScore", () => {
  it("scores a long-dead sizable index high", () => {
    const score = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 125,
      redundant: false,
      sizeBytes: 1024 ** 3,
      regressionWeight: 0,
    });
    expect(score).toBeGreaterThanOrEqual(RECOMMENDED_AUTO_APPLY_SCORE);
  });

  // The same index on three days of watching. This case used to score 72 — above
  // the threshold this file recommends — on two points of history credit, which is
  // what made lowering the proposal gate a change to what gets DELETED rather than
  // to what is displayed (#434). It still surfaces; it just cannot auto-apply.
  it("does not reach the recommended threshold on a first-week history", () => {
    const score = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 12,
      redundant: false,
      sizeBytes: 1024 ** 3,
      regressionWeight: 0,
    });
    expect(score).toBeLessThan(RECOMMENDED_AUTO_APPLY_SCORE);
    expect(score).toBeGreaterThan(0);
  });

  // The top of the range has to exist, or a threshold above it approves
  // nothing while looking like a valid setting.
  it("reaches 100 for the strongest case the engine can make", () => {
    expect(
      dropScore({
        usageClass: null,
        snapshots: 125,
        redundant: true,
        sizeBytes: 1024 ** 3,
        regressionWeight: 0,
      }),
    ).toBe(100);
  });

  it("needs a month of history for full evidence credit, not two days", () => {
    const base = {
      usageClass: "FLAT_ZERO" as const,
      redundant: false,
      sizeBytes: 0,
      regressionWeight: 0,
    };
    // 10 snapshots is 2.5 days at the 6h cadence — it used to max the term out.
    expect(dropScore({ ...base, snapshots: 10 })).toBeLessThan(
      dropScore({ ...base, snapshots: 125 }),
    );
  });

  it("clears the recommended threshold on evidence, and not without it", () => {
    // Redundant, a month of history, a gigabyte back.
    expect(
      dropScore({
        usageClass: null,
        snapshots: 125,
        redundant: true,
        sizeBytes: 1024 ** 3,
        regressionWeight: 0,
      }),
    ).toBeGreaterThanOrEqual(RECOMMENDED_AUTO_APPLY_SCORE);
    // Was periodic and went quiet, thin history, tiny index — a human's call.
    expect(
      dropScore({
        usageClass: "PERIODIC_DEAD",
        snapshots: 15,
        redundant: false,
        sizeBytes: 4096,
        regressionWeight: 0,
      }),
    ).toBeLessThan(RECOMMENDED_AUTO_APPLY_SCORE);
  });
  it("scores redundancy high even with live usage", () => {
    const score = dropScore({
      usageClass: null,
      snapshots: 5,
      redundant: true,
      sizeBytes: 0,
      regressionWeight: 0,
    });
    expect(score).toBeGreaterThanOrEqual(50);
  });
  it("past regressions collapse the score", () => {
    const clean = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 10,
      redundant: false,
      sizeBytes: 0,
      regressionWeight: 0,
    });
    const burned = dropScore({
      usageClass: "FLAT_ZERO",
      snapshots: 10,
      redundant: false,
      sizeBytes: 0,
      regressionWeight: 1,
    });
    expect(burned).toBeLessThan(clean - 30);
  });
  it("clamps to 0..100", () => {
    // The terms sum to exactly 100 at their caps, so overshooting means
    // exceeding every cap at once.
    expect(
      dropScore({
        usageClass: "FLAT_ZERO",
        snapshots: 10_000,
        redundant: true,
        sizeBytes: 10 * 1024 ** 3,
        regressionWeight: 0,
      }),
    ).toBe(100);
    expect(
      dropScore({
        usageClass: null,
        snapshots: 0,
        redundant: false,
        sizeBytes: 0,
        regressionWeight: 3,
      }),
    ).toBe(0);
  });
});

// The per-collection budget (#281). Every collision guard in the engine is keyed
// on an index; the cost of an index is paid per collection, so five individually
// correct creates on one collection are five defensible proposals that together
// double its write cost — and nothing formed that thought.
describe("crowdingPenalty", () => {
  it("charges nothing for an ordinary collection", () => {
    expect(crowdingPenalty(1)).toBe(0);
    expect(crowdingPenalty(4)).toBe(0);
  });

  it("charges a step per index past ordinary", () => {
    expect(crowdingPenalty(5)).toBe(10);
    expect(crowdingPenalty(6)).toBe(20);
    expect(crowdingPenalty(7)).toBe(30);
  });

  // Capped at the same 40 REGRESSION_PENALTY costs, which is this file's word for
  // "close to disqualifying" — not "disqualified". A CRITICAL scan on a crowded
  // collection is still a real finding and still gets proposed.
  it("stops at close-to-disqualifying rather than vetoing", () => {
    expect(crowdingPenalty(8)).toBe(40);
    expect(crowdingPenalty(40)).toBe(40);
  });
});

describe("createScore", () => {
  // The issue's own scenario: five individually defensible creates on one
  // collection, with the recommended threshold set. The first goes unattended and
  // the tail becomes a decision — rather than all five landing in whatever order
  // the change windows fall.
  it("lets the first build through and makes the later ones a decision", () => {
    const strong = { collscan: true, count: 30, docCount: 50_000, regressionWeight: 0 };
    const scores = [1, 2, 3, 4, 5].map((nth) =>
      createScore({ ...strong, collectionIndexes: 3 + nth }),
    );
    const [first] = scores;
    expect(first).toBeGreaterThanOrEqual(RECOMMENDED_AUTO_APPLY_SCORE);
    expect(scores.at(-1)).toBeLessThan(RECOMMENDED_AUTO_APPLY_SCORE);
    // The number that matters is how many the engine will build BY ITSELF. Not
    // pinned to an exact count — that would be pinning the calibration rather
    // than the property — but it must be a small minority of five.
    expect(scores.filter((score) => score >= RECOMMENDED_AUTO_APPLY_SCORE).length).toBeLessThan(3);
    // Monotone: each additional index on the collection costs, so the staircase
    // reads the way an owner would predict it.
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("charges nothing when the collection is not crowded", () => {
    const base = { collscan: true, count: 30, docCount: 50_000, regressionWeight: 0 };
    expect(createScore({ ...base, collectionIndexes: 4 })).toBe(createScore(base));
  });

  // A missing count is not evidence of an uncrowded collection — a caller with no
  // index list must not be silently credited with one.
  it("skips the term rather than guessing when no count is given", () => {
    const base = { collscan: true, count: 30, docCount: 50_000, regressionWeight: 0 };
    expect(createScore(base)).toBe(createScore({ ...base, collectionIndexes: 1 }));
  });

  // Never below zero, and never a negative that reads as a different kind of
  // finding: the clamp is what the score's own contract promises.
  it("stays inside the scale on a badly crowded collection", () => {
    const score = createScore({
      collscan: false,
      sortedInMemory: true,
      count: 3,
      docCount: 500,
      regressionWeight: 1,
      collectionIndexes: 30,
    });
    expect(score).toBe(0);
  });

  it("scores a hot collscan on a critical collection high", () => {
    expect(
      createScore({ collscan: true, count: 30, docCount: 50_000, regressionWeight: 0 }),
    ).toBeGreaterThanOrEqual(75);
  });

  it("scores an in-memory sort below the same shape scanning", () => {
    const base = { count: 30, docCount: 50_000, regressionWeight: 0 };
    const sorting = createScore({ ...base, collscan: false, sortedInMemory: true });
    const scanning = createScore({ ...base, collscan: true });
    expect(sorting).toBeLessThan(scanning);
    // Still an argument, not a footnote: the sort can fail outright at 100 MB.
    expect(sorting).toBeGreaterThanOrEqual(50);
  });

  it("gives no create credit to a shape that neither scans nor sorts", () => {
    const idle = createScore({ collscan: false, count: 30, docCount: 50_000, regressionWeight: 0 });
    expect(idle).toBeLessThan(
      createScore({
        collscan: false,
        sortedInMemory: true,
        count: 30,
        docCount: 50_000,
        regressionWeight: 0,
      }),
    );
  });

  it("reaches 100 for a constant, critically costly scan on a huge collection", () => {
    expect(
      createScore({
        collscan: true,
        count: 35,
        docCount: 1_000_000,
        severity: "CRITICAL",
        regressionWeight: 0,
      }),
    ).toBe(100);
  });

  it("ranks a measured-critical scan above an identical one that is not", () => {
    const base = { collscan: true, count: 10, docCount: 50_000, regressionWeight: 0 } as const;
    expect(createScore({ ...base, severity: "CRITICAL" })).toBeGreaterThan(
      createScore({ ...base, severity: "ROUTINE" }),
    );
  });
  it("a single scan on a small collection stays modest", () => {
    expect(
      createScore({ collscan: true, count: 1, docCount: 1500, regressionWeight: 0 }),
    ).toBeLessThan(50);
  });
  it("past rollback collapses the score", () => {
    expect(
      createScore({ collscan: true, count: 30, docCount: 50_000, regressionWeight: 2 }),
    ).toBeLessThanOrEqual(10);
  });
});

describe("narrowScore", () => {
  const strong = {
    observedCount: 5000,
    droppedKeys: 2,
    totalKeys: 3,
    sizeBytes: 4 * 1024 ** 3,
    regressionWeight: 0,
  } as const;

  // The whole point of the ceiling: narrowing argues from absence of evidence,
  // so it always waits for a human however good the case looks.
  it("cannot reach the recommended auto-apply threshold", () => {
    expect(narrowScore(strong)).toBeLessThan(RECOMMENDED_AUTO_APPLY_SCORE);
  });

  it("rewards traffic behind the claim", () => {
    expect(narrowScore(strong)).toBeGreaterThan(narrowScore({ ...strong, observedCount: 20 }));
  });

  it("rewards reclaiming more of a bigger index", () => {
    expect(narrowScore(strong)).toBeGreaterThan(narrowScore({ ...strong, sizeBytes: 1024 }));
    expect(narrowScore(strong)).toBeGreaterThan(
      narrowScore({ ...strong, droppedKeys: 1, totalKeys: 6 }),
    );
  });

  it("a thin sample on a small index barely registers", () => {
    expect(
      narrowScore({
        observedCount: 3,
        droppedKeys: 1,
        totalKeys: 4,
        sizeBytes: 1024,
        regressionWeight: 0,
      }),
    ).toBeLessThan(25);
  });

  // The cooldown already blocks re-proposal outright for a period; once it
  // expires the score has to carry the memory.
  it("past rollback collapses the score", () => {
    expect(narrowScore({ ...strong, regressionWeight: 1 })).toBeLessThan(20);
    expect(narrowScore({ ...strong, regressionWeight: 2 })).toBe(0);
  });
});

// The penalty used to be permanent, and nothing chose that: the cooldown was
// built to expire and the count to escalate, but the score read the count with
// no clock and `index_cooldowns` is never purged. One regression capped a drop
// at 55 against a suggested auto-approve of 70 — so a single failed experiment
// disqualified an index from unattended cleanup for the life of the cluster.
describe("regressionWeight", () => {
  const DAY = 86_400_000;
  const at = (days: number) => new Date(Date.UTC(2026, 0, 1) + days * DAY);
  // One regression on a 30-day observe window buys a 30-day cooldown since D136
  // (one window, doubling per repeat), so this row was written on day 0 and
  // blocks until day 30.
  const once = { regressionCount: 1, until: at(30) };

  it("counts in full while the cooldown it bought is still running", () => {
    expect(regressionWeight(once, 30, at(0))).toBe(1);
    expect(regressionWeight(once, 30, at(29))).toBe(1);
  });

  it("fades over the same span again once the block lifts", () => {
    expect(regressionWeight(once, 30, at(30))).toBe(1);
    expect(regressionWeight(once, 30, at(45))).toBeCloseTo(0.5, 5);
    expect(regressionWeight(once, 30, at(52.5))).toBeCloseTo(0.25, 5);
  });

  it("reaches zero, so a workload that has moved on is not still paying", () => {
    expect(regressionWeight(once, 30, at(60))).toBe(0);
    expect(regressionWeight(once, 30, at(400))).toBe(0);
  });

  // The escalation looks after itself: a second regression buys twice the
  // cooldown, so it starts twice as deep AND takes twice as long to fade.
  it("keeps a repeat offender down for longer without a second rule", () => {
    const twice = { regressionCount: 2, until: at(60) };
    expect(regressionWeight(twice, 30, at(59))).toBe(2);
    expect(regressionWeight(twice, 30, at(90))).toBeCloseTo(1, 5);
    expect(regressionWeight(twice, 30, at(120))).toBe(0);
  });

  it("is nothing at all for the owner-veto rows, which carry no count", () => {
    expect(regressionWeight({ regressionCount: 0, until: at(90) }, 30, at(0))).toBe(0);
  });

  // An open-ended park is the owner saying never (D136). The block it bought has
  // not started fading, so the weight stands — and a row with no count still
  // weighs nothing, which is every manual veto.
  it("holds at full weight for a park with no end", () => {
    expect(regressionWeight({ regressionCount: 2, until: null }, 30, at(4000))).toBe(2);
    expect(regressionWeight({ regressionCount: 0, until: null }, 30, at(0))).toBe(0);
  });

  // A shortened observe window is an owner asking for faster verdicts; the fade
  // follows the current policy rather than a span policy no longer stands behind.
  it("follows the policy in force rather than the one at the time", () => {
    expect(regressionWeight(once, 7, at(30 + 3.5))).toBeCloseTo(0.5, 5);
  });

  it("survives a row whose date cannot be read", () => {
    expect(regressionWeight({ regressionCount: 1, until: "not a date" }, 30, at(0))).toBe(1);
  });
});

// The whole point of the fade, stated as the number a reader cares about.
describe("a faded regression stops disqualifying a drop", () => {
  const DAY = 86_400_000;
  const at = (days: number) => new Date(Date.UTC(2026, 0, 1) + days * DAY);
  const signals = (weight: number) => ({
    usageClass: "FLAT_ZERO" as const,
    snapshots: 125,
    redundant: false,
    sizeBytes: 1_000_000_000,
    regressionWeight: weight,
  });

  it("caps the score under 70 while the regression still counts", () => {
    expect(dropScore(signals(1))).toBeLessThan(70);
  });

  it("clears the suggested auto-approve threshold once it has faded", () => {
    const faded = regressionWeight({ regressionCount: 1, until: at(90) }, 30, at(180));
    expect(dropScore(signals(faded))).toBeGreaterThanOrEqual(70);
  });
});

describe("thinEvidencePenalty", () => {
  // Zero exactly where a week of collects lands, so nothing about the scale past
  // the first week moves and the ceiling on a drop is untouched.
  it("is zero from a week of collects onward", () => {
    expect(thinEvidencePenalty(28)).toBe(0);
    expect(thinEvidencePenalty(125)).toBe(0);
  });

  it("discounts a shorter history, hardest at the start", () => {
    expect(thinEvidencePenalty(12)).toBe(14);
    expect(thinEvidencePenalty(3)).toBeGreaterThan(thinEvidencePenalty(20));
  });

  // A redundancy finding is provable from the index list and claims no span, so
  // dropScore never charges it this — otherwise the strongest case the engine can
  // make would stop reaching 100.
  it("is not applied to a redundancy finding", () => {
    const score = dropScore({
      usageClass: null,
      snapshots: 3,
      redundant: true,
      sizeBytes: 0,
      regressionWeight: 0,
    });
    expect(score).toBe(55);
  });
});

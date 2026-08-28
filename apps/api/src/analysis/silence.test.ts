import { describe, expect, it } from "vitest";
import {
  type AnalysisSilence,
  dominantRefusal,
  explainRefusal,
  explainSuppression,
  type RefusalCounts,
  SUPPRESSION_GUARDS,
  usageAnalysisPaused,
} from "./silence";

const OPTIONS = {
  minHistory: 3,
  minHistoryDays: 7,
  minActiveHours: 72,
  maxGapHours: 48,
};

const silence = (overrides: Partial<AnalysisSilence> = {}): AnalysisSilence => ({
  consideredIndexes: 0,
  trustedIndexes: 0,
  refusals: {},
  suppressed: {},
  ...overrides,
});

describe("dominantRefusal", () => {
  it("is null when nothing was refused", () => {
    expect(dominantRefusal({})).toBeNull();
  });

  it("picks the refusal accounting for the most indexes", () => {
    expect(dominantRefusal({ "span-too-short": 2, "history-stale": 9 })).toBe("history-stale");
    expect(dominantRefusal({ "span-too-short": 9, "history-stale": 2 })).toBe("span-too-short");
  });

  // A restart no longer refuses anything, so nothing writes this key any more —
  // but rows written before that change still carry it, and the panel reads
  // them. Skipped rather than surfaced, the same way an unknown suppression
  // guard is: the alternative is a dashboard explaining a rule that is gone.
  it("ignores a stored kind it no longer knows", () => {
    expect(dominantRefusal({ "counters-reset": 99, "span-too-short": 1 } as RefusalCounts)).toBe(
      "span-too-short",
    );
  });

  // The whole point of a fixed precedence: two passes that measure the same
  // thing must not report different reasons, and an object's key order is not
  // something to rest that on.
  it("breaks a tie the same way whatever order the counts arrive in", () => {
    const forwards: RefusalCounts = { "history-stale": 4, "too-few-collects": 4 };
    const backwards: RefusalCounts = { "too-few-collects": 4, "history-stale": 4 };
    expect(dominantRefusal(forwards)).toBe("history-stale");
    expect(dominantRefusal(backwards)).toBe("history-stale");
  });

  // Ties go to the condition that can persist. A warm-up clears itself with
  // nothing but time; a cluster we have stopped hearing from does not, so it is
  // the one worth the customer's attention.
  it("prefers the reason that does not clear on its own", () => {
    expect(dominantRefusal({ "history-stale": 1, "span-too-short": 1 })).toBe("history-stale");
    expect(dominantRefusal({ "history-stale": 1, "no-history": 1 })).toBe("history-stale");
  });

  it("ignores a kind counted zero", () => {
    expect(dominantRefusal({ "history-stale": 0, "span-too-short": 3 })).toBe("span-too-short");
  });
});

describe("usageAnalysisPaused", () => {
  // One trusted index means the machinery works. Reporting "paused" there would
  // be crying wolf on any cluster with a mix of old and new indexes, which is
  // every cluster.
  it("is false when anything cleared the gate", () => {
    expect(
      usageAnalysisPaused(
        silence({ consideredIndexes: 10, trustedIndexes: 1, refusals: { "span-too-short": 9 } }),
      ),
    ).toBe(false);
  });

  it("is true only when nothing did", () => {
    expect(
      usageAnalysisPaused(
        silence({ consideredIndexes: 9, trustedIndexes: 0, refusals: { "span-too-short": 9 } }),
      ),
    ).toBe(true);
  });

  // A cluster with nothing eligible — every index protected, or no indexes at
  // all — has not had usage analysis withheld from it. Zero over zero is not a
  // pause, and drawing one would put a permanent warning on an empty cluster.
  it("is false when there was nothing to consider", () => {
    expect(usageAnalysisPaused(silence({ consideredIndexes: 0, trustedIndexes: 0 }))).toBe(false);
  });
});

describe("explainRefusal", () => {
  // The thresholds are the reason this sentence lives beside the gate rather
  // than in the dashboard: it has to be able to quote them.
  it("quotes the observation window the gate actually used", () => {
    const text = explainRefusal("span-too-short", { ...OPTIONS, minHistoryDays: 14 });
    expect(text).toContain("less than 14 days");
    expect(text).not.toContain("7 days");
  });

  // The sentence a restarting cluster now gets, and the one thing it must not
  // leave the reader believing: that a restart threw the watching away.
  it("says a restart costs the blind minutes and not the history", () => {
    const text = explainRefusal("span-too-short", OPTIONS);
    expect(text).toContain("A restart does not reset that clock");
    expect(text).toContain("still counts");
  });

  // The warm-up is reassuring and has to read that way: a fresh cluster is not
  // broken, and the panel is the first thing an owner sees on day one.
  it("reads a short span as a warm-up, not a fault", () => {
    expect(explainRefusal("span-too-short", OPTIONS)).toContain("warm-up, not a fault");
  });

  it("says what is still working, whichever reason it gives", () => {
    for (const kind of [
      "no-history",
      "too-few-collects",
      "span-too-short",
      "collection-idle",
      "gap-inside-run",
      "gap-between-runs",
      "history-stale",
    ] as const) {
      expect(explainRefusal(kind, OPTIONS), kind).toContain("Redundancy findings are unaffected.");
    }
  });

  it("quotes the gap tolerance and the activity floor where they apply", () => {
    expect(explainRefusal("gap-between-runs", { ...OPTIONS, maxGapHours: 36 })).toContain(
      "36 hours",
    );
    expect(explainRefusal("collection-idle", { ...OPTIONS, minActiveHours: 96 })).toContain(
      "96 hours",
    );
    expect(explainRefusal("too-few-collects", { ...OPTIONS, minHistory: 5 })).toContain(
      "Fewer than 5 collects",
    );
  });
});

describe("explainSuppression", () => {
  it("agrees with itself about one", () => {
    expect(explainSuppression("cooldown", 1)).toContain("1 finding held back");
    expect(explainSuppression("cooldown", 4)).toContain("4 findings held back");
  });

  // A guard with no sentence would surface as a count with no explanation, which
  // is the state this whole panel exists to remove.
  it("has a sentence for every guard", () => {
    for (const guard of SUPPRESSION_GUARDS) {
      expect(explainSuppression(guard, 2), guard).toMatch(/^2 findings held back/);
    }
  });

  // The hinted guard withholds the automatic drop and lets the advisory through,
  // so saying "held back" flatly would overstate it.
  it("distinguishes withholding the action from withholding the finding", () => {
    expect(explainSuppression("hinted", 1)).toContain("from automatic action");
    expect(explainSuppression("standing", 1)).not.toContain("from automatic action");
  });
});

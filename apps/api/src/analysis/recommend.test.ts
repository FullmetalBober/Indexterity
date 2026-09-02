import { describe, expect, it } from "vitest";
import type { IndexKey, IndexSpec } from "../engine/types";
import { type IndexInput, parseStoredSpec, recommendForCollection } from "./recommend";
import type { UsageSnapshot } from "./types";

function spec(name: string, keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
  return {
    name,
    keys,
    unique: false,
    ttl: false,
    partial: false,
    partialFilter: null,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
    ...overrides,
  };
}

// Each entry is the ACTIVITY in that interval; the helper accumulates it into
// the cumulative counter mongod reports, which is what the analysis reads and
// differences back (#265).
function input(indexSpec: IndexSpec, activityPerSnapshot: number[]): IndexInput {
  let counter = 0;
  const history: UsageSnapshot[] = activityPerSnapshot.map((activity, i) => {
    counter += activity;
    return {
      capturedAt: `2026-01-0${i + 1}T00:00:00Z`,
      perMember: [{ member: "m", ops: counter, since: "" }],
    };
  });
  return { spec: indexSpec, history };
}

const options = {
  recentHours: 12,
  minHistory: 3,
  minHistoryDays: 0,
  minActiveHours: 0,
  maxGapHours: 48,
};
// The fixtures' newest snapshot is 2026-01-03; judge from just after it, since
// usage findings now require a history that is both gapless and current.
const NOW = new Date("2026-01-03T06:00:00Z");
const x1: IndexKey = { field: "x", direction: 1 };
const y1: IndexKey = { field: "y", direction: 1 };

describe("recommendForCollection", () => {
  it("proposes DROP_UNUSED for an idle index with its size", () => {
    const idle = input(spec("stale", [{ field: "s", direction: 1 }]), [0, 0, 0]);
    const out = recommendForCollection([idle], { stale: 4096 }, options, {}, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("DROP_UNUSED");
    expect(out[0]?.estimatedBytesSaved).toBe(4096);
  });

  // The span is carried onto the finding so the promotion floor can be applied
  // without re-reading the history (#434). Null on a structural finding, which is
  // what stops a redundancy verdict being held back by a short history it never
  // rested on.
  it("carries the evidence span on a usage finding and not on a structural one", () => {
    const idle = input(spec("stale", [{ field: "s", direction: 1 }]), [0, 0, 0]);
    const [unused] = recommendForCollection([idle], {}, options, {}, NOW);
    expect(unused?.type).toBe("DROP_UNUSED");
    // The fixture spans 2026-01-01 to 2026-01-03, floored to whole days.
    expect(unused?.evidenceDays).toBe(2);

    const a = input(spec("a", [x1]), [5, 5, 5]);
    const ab = input(spec("ab", [x1, y1]), [5, 5, 5]);
    const out = recommendForCollection([a, ab], {}, options, {}, NOW);
    expect(out.find((c) => c.type === "DROP_REDUNDANT")?.evidenceDays).toBeNull();
  });

  it("proposes DROP_REDUNDANT for a prefix covered by a compound", () => {
    const a = input(spec("a", [x1]), [5, 5, 5]);
    const ab = input(spec("ab", [x1, y1]), [5, 5, 5]);
    const out = recommendForCollection([a, ab], {}, options, {}, NOW);
    expect(out.some((c) => c.type === "DROP_REDUNDANT" && c.indexName === "a")).toBe(true);
    expect(out.some((c) => c.indexName === "ab")).toBe(false);
  });

  // Ops are non-zero throughout so the DROP_UNUSED path stays out of the way
  // and only the redundancy verdict is under test.
  it("does not fold a plain index into a restricted superset", () => {
    const plain = input(spec("a", [x1]), [5, 5, 5]);
    for (const restriction of [{ partial: true }, { sparse: true }, { hidden: true }]) {
      const wider = input(spec("ab", [x1, y1], restriction), [5, 5, 5]);
      const out = recommendForCollection([plain, wider], {}, options, {}, NOW);
      expect(out.some((c) => c.type === "DROP_REDUNDANT")).toBe(false);
    }
  });

  it("never proposes dropping _id_ or unique indexes (unused unique -> advisory)", () => {
    const id = input(spec("_id_", [x1]), [0, 0, 0]);
    const uniq = input(spec("u", [x1], { unique: true }), [0, 0, 0]);
    const out = recommendForCollection([id, uniq], {}, options, {}, NOW);
    expect(out.every((c) => c.type === "ADVISORY_REVIEW")).toBe(true);
    expect(out.some((c) => c.indexName === "_id_")).toBe(false);
  });

  it("keeps a continuously-used index", () => {
    const hot = input(spec("hot", [{ field: "h", direction: 1 }]), [3, 3, 3]);
    expect(recommendForCollection([hot], {}, options, {}, NOW)).toHaveLength(0);
  });

  // Says NOTHING about an unused unique, TTL or shard-key index, which is the
  // whole of D134. It used to advise on all three, and the premise was false:
  // `$indexStats.accesses.ops` counts QUERY access only, so a unique index that
  // enforced its constraint across fifty inserts and a TTL index expiring
  // documents both sit at ops 0 for ever (measured, mongod 7.0.39). FLAT_ZERO is
  // their expected state, so "no recorded usage" was never a finding about them.
  it("says nothing about an unused unique, TTL or shard-key index", () => {
    const cases = [
      spec("expiry_ttl", [{ field: "at", direction: 1 }], { ttl: true }),
      spec("email_unique", [{ field: "email", direction: 1 }], { unique: true }),
      spec("shard_key", [{ field: "tenant", direction: 1 }], { isShardKey: true }),
    ];
    for (const protected_ of cases) {
      const idle = input(protected_, [0, 0, 0]);
      expect(recommendForCollection([idle], { [protected_.name]: 2048 }, options, {}, NOW)).toEqual(
        [],
      );
    }
  });

  it("never advises on _id_ or on used protected indexes", () => {
    const id = input(spec("_id_", [x1]), [0, 0, 0]);
    const busyUnique = input(spec("u", [y1], { unique: true }), [3, 3, 3]);
    expect(recommendForCollection([id, busyUnique], {}, options, {}, NOW)).toHaveLength(0);
  });

  // A text index reaches the advisory tier rather than DROP_UNUSED: hiding one
  // makes $text fail outright, so the observe window cannot be run on it and every
  // gate downstream would read that outage as evidence the index was dead.
  it("advises on an unused text index instead of proposing a drop", () => {
    const text = input(spec("name_text", [{ field: "name", direction: "text" }]), [0, 0, 0]);
    const out = recommendForCollection([text], { name_text: 8192 }, options, {}, NOW);
    expect(out.map((c) => c.type)).toEqual(["ADVISORY_REVIEW"]);
    expect(out[0]?.rationale).toContain("$text");
    // Still scored and still on screen: the advisory tier exists so that nothing
    // is silently withheld.
    expect(out[0]?.score).toBeGreaterThan(0);
    expect(out[0]?.estimatedBytesSaved).toBe(8192);
  });

  it("advises on an unused 2dsphere index and names the operator that would fail", () => {
    const geo = input(spec("loc_2dsphere", [{ field: "loc", direction: "2dsphere" }]), [0, 0, 0]);
    const out = recommendForCollection([geo], {}, options, {}, NOW);
    expect(out.map((c) => c.type)).toEqual(["ADVISORY_REVIEW"]);
    expect(out[0]?.rationale).toContain("$near");
  });

  // The legacy geo form, and why the collector must stop coercing it to 1: as
  // `{loc: 1}` it is not merely unprotected, it reads as an ordinary key-prefix of
  // the compound and is proposed as DROP_REDUNDANT — a structural finding that
  // needs no usage evidence at all.
  it("never folds a 2d index into a wider compound", () => {
    const geo = input(spec("loc_2d", [{ field: "loc", direction: "2d" }]), [5, 5, 5]);
    const wider = input(
      spec("loc_ts", [
        { field: "loc", direction: 1 },
        { field: "ts", direction: 1 },
      ]),
      [5, 5, 5],
    );
    expect(recommendForCollection([geo, wider], {}, options, {}, NOW)).toHaveLength(0);
  });

  // hashed is not in that class — hidden, it degrades to a collection scan, which
  // is the regression the observe gate is there to catch.
  it("still proposes dropping an unused hashed index", () => {
    const hashed = input(spec("k_hashed", [{ field: "k", direction: "hashed" }]), [0, 0, 0]);
    const out = recommendForCollection([hashed], {}, options, {}, NOW);
    expect(out.map((c) => c.type)).toEqual(["DROP_UNUSED"]);
  });

  it("parseStoredSpec rehydrates a persisted spec", () => {
    const parsed = parseStoredSpec({
      name: "x",
      keys: [{ field: "a", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
    });
    expect(parsed.name).toBe("x");
    expect(parsed.keys[0]?.field).toBe("a");
  });

  // Rehydration has to accept every form the collector now persists, or the rule
  // that protects a legacy geo index throws before it can run.
  it("parseStoredSpec accepts the legacy 2d key form", () => {
    const parsed = parseStoredSpec({
      name: "loc_2d",
      keys: [{ field: "loc", direction: "2d" }],
      unique: false,
      ttl: false,
      partial: false,
      partialFilter: null,
      sparse: false,
      hidden: false,
      isShardKey: false,
    });
    expect(parsed.keys[0]?.direction).toBe("2d");
  });
});

describe("unique-prefix advisory", () => {
  it("flags a unique index whose keys prefix a wider index", () => {
    const unique = input(
      spec("email_1", [{ field: "email", direction: 1 }], { unique: true }),
      [5, 5, 5],
    );
    const wider = input(
      spec("email_1_tenant_1", [
        { field: "email", direction: 1 },
        { field: "tenant", direction: 1 },
      ]),
      [9, 9, 9],
    );
    const out = recommendForCollection([unique, wider], {}, options, {}, NOW);
    const advisory = out.find((c) => c.type === "ADVISORY_REVIEW" && c.indexName === "email_1");
    expect(advisory).toBeDefined();
    expect(advisory?.rationale).toContain("uniqueness constraint");
  });

  it("stays silent for different collations and shard keys", () => {
    const uniqueCollated = input(
      spec("email_ci", [{ field: "email", direction: 1 }], { unique: true, collation: "en" }),
      [5, 5, 5],
    );
    const shardKey = input(
      spec("email_shard", [{ field: "email", direction: 1 }], { unique: true, isShardKey: true }),
      [5, 5, 5],
    );
    const wider = input(
      spec("email_1_tenant_1", [
        { field: "email", direction: 1 },
        { field: "tenant", direction: 1 },
      ]),
      [9, 9, 9],
    );
    const out = recommendForCollection([uniqueCollated, shardKey, wider], {}, options, {}, NOW);
    expect(
      out.some((c) => c.indexName === "email_ci" && c.rationale.includes("uniqueness constraint")),
    ).toBe(false);
    expect(
      out.some(
        (c) => c.indexName === "email_shard" && c.rationale.includes("uniqueness constraint"),
      ),
    ).toBe(false);
  });
});

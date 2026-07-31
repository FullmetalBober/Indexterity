import { describe, expect, it } from "vitest";
import { type IndexInput, parseStoredSpec, recommendForCollection } from "./recommend";
import type { IndexKey, IndexSpec, UsageSnapshot } from "./types";

function spec(name: string, keys: IndexKey[], overrides: Partial<IndexSpec> = {}): IndexSpec {
  return {
    name,
    keys,
    unique: false,
    ttl: false,
    partial: false,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
    ...overrides,
  };
}

function input(indexSpec: IndexSpec, opsPerSnapshot: number[]): IndexInput {
  const history: UsageSnapshot[] = opsPerSnapshot.map((ops, i) => ({
    capturedAt: `2026-01-0${i + 1}T00:00:00Z`,
    perMember: [{ member: "m", ops, since: "" }],
  }));
  return { spec: indexSpec, history };
}

const options = { recentWindow: 3, minHistory: 3, maxGapHours: 48 };
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

  it("surfaces an unused protected index as ADVISORY_REVIEW, never a drop", () => {
    const ttl = input(
      spec("expiry_ttl", [{ field: "at", direction: 1 }], { ttl: true }),
      [0, 0, 0],
    );
    const out = recommendForCollection([ttl], { expiry_ttl: 2048 }, options, {}, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("ADVISORY_REVIEW");
    expect(out[0]?.estimatedBytesSaved).toBe(2048);
  });

  it("never advises on _id_ or on used protected indexes", () => {
    const id = input(spec("_id_", [x1]), [0, 0, 0]);
    const busyUnique = input(spec("u", [y1], { unique: true }), [3, 3, 3]);
    expect(recommendForCollection([id, busyUnique], {}, options, {}, NOW)).toHaveLength(0);
  });

  it("parseStoredSpec rehydrates a persisted spec", () => {
    const parsed = parseStoredSpec({
      name: "x",
      keys: [{ field: "a", direction: 1 }],
      unique: false,
      ttl: false,
      partial: false,
      sparse: false,
      hidden: false,
      isShardKey: false,
    });
    expect(parsed.name).toBe("x");
    expect(parsed.keys[0]?.field).toBe("a");
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

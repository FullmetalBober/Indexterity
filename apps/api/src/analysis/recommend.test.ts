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
    ...overrides,
  };
}

function input(indexSpec: IndexSpec, opsPerSnapshot: number[]): IndexInput {
  const history: UsageSnapshot[] = opsPerSnapshot.map((ops, i) => ({
    capturedAt: `2026-01-0${i + 1}T00:00:00Z`,
    perMember: [{ member: "m", ops, since: "", uptimeSeconds: 100 }],
  }));
  return { spec: indexSpec, history };
}

const options = { recentWindow: 3, minHistory: 3 };
const x1: IndexKey = { field: "x", direction: 1 };
const y1: IndexKey = { field: "y", direction: 1 };

describe("recommendForCollection", () => {
  it("proposes DROP_UNUSED for an idle index with its size", () => {
    const idle = input(spec("stale", [{ field: "s", direction: 1 }]), [0, 0, 0]);
    const out = recommendForCollection([idle], { stale: 4096 }, options);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("DROP_UNUSED");
    expect(out[0]?.estimatedBytesSaved).toBe(4096);
  });

  it("proposes DROP_REDUNDANT for a prefix covered by a compound", () => {
    const a = input(spec("a", [x1]), [5, 5, 5]);
    const ab = input(spec("ab", [x1, y1]), [5, 5, 5]);
    const out = recommendForCollection([a, ab], {}, options);
    expect(out.some((c) => c.type === "DROP_REDUNDANT" && c.indexName === "a")).toBe(true);
    expect(out.some((c) => c.indexName === "ab")).toBe(false);
  });

  it("never proposes _id_ or unique indexes", () => {
    const id = input(spec("_id_", [x1]), [0, 0, 0]);
    const uniq = input(spec("u", [x1], { unique: true }), [0, 0, 0]);
    expect(recommendForCollection([id, uniq], {}, options)).toHaveLength(0);
  });

  it("keeps a continuously-used index", () => {
    const hot = input(spec("hot", [{ field: "h", direction: 1 }]), [3, 3, 3]);
    expect(recommendForCollection([hot], {}, options)).toHaveLength(0);
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

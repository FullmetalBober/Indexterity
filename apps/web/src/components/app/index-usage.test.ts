import type { ClusterNodes, IndexUsage } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { present } from "~/lib/at";
import { usageDetail, usageLine, usageSplit } from "./index-usage";

function usage(perMember: { member: string; ops: number }[]): IndexUsage {
  return {
    recommendationId: "11111111-1111-4111-8111-111111111111",
    totalOps: perMember.reduce((sum, entry) => sum + entry.ops, 0),
    perMember,
    observedAt: "2026-08-11T09:00:00.000Z",
  };
}

function roster(nodes: ClusterNodes["nodes"]): ClusterNodes {
  return { clusterId: "c1", collectedAt: "2026-08-11T09:00:00.000Z", nodes };
}

const THREE_ANSWERED = roster([
  { host: "a:27017", role: "primary", state: "answered" },
  { host: "b:27017", role: "secondary", state: "answered" },
  { host: "c:27017", role: "secondary", state: "answered" },
]);

describe("usageSplit", () => {
  // The distinction the whole of #161 is about: summed, these two are the same
  // row, and one of them breaks a reporting client if you drop it.
  it("flags an index whose traffic is all on one member", () => {
    const split = usageSplit(
      usage([
        { member: "b:27017", ops: 40_000 },
        { member: "a:27017", ops: 0 },
        { member: "c:27017", ops: 0 },
      ]),
      THREE_ANSWERED,
    );
    expect(split?.concentrated).toBe(true);
    expect(split?.activeCount).toBe(1);
    expect(usageLine(present(split, "the split usage"))).toBe("40,000 ops · 1 of 3 nodes");
  });

  it("does not flag traffic spread across the set", () => {
    const split = usageSplit(
      usage([
        { member: "a:27017", ops: 14_000 },
        { member: "b:27017", ops: 13_000 },
        { member: "c:27017", ops: 13_000 },
      ]),
      THREE_ANSWERED,
    );
    expect(split?.concentrated).toBe(false);
    expect(usageLine(present(split, "the split usage"))).toBe("40,000 ops · 3 of 3 nodes");
  });

  // A secondary serving a nightly report still picks up the odd stray query, so
  // the rule cannot be "exactly one member".
  it("flags a member carrying nearly all of it, not only all of it", () => {
    const split = usageSplit(
      usage([
        { member: "b:27017", ops: 9_500 },
        { member: "a:27017", ops: 500 },
      ]),
      THREE_ANSWERED,
    );
    expect(split?.concentrated).toBe(true);
  });

  // A standalone is not a concentration finding. Everything is on one node
  // because there is one node.
  it("says nothing about concentration on a single-member cluster", () => {
    const split = usageSplit(
      usage([{ member: "a:27017", ops: 40_000 }]),
      roster([{ host: "a:27017", role: "standalone", state: "answered" }]),
    );
    expect(split?.concentrated).toBe(false);
  });

  it("does not call an unused index concentrated", () => {
    const split = usageSplit(
      usage([
        { member: "a:27017", ops: 0 },
        { member: "b:27017", ops: 0 },
      ]),
      THREE_ANSWERED,
    );
    expect(split?.concentrated).toBe(false);
    expect(split?.activeCount).toBe(0);
  });

  // The half that makes this safe to ship. A per-node number that silently omits
  // an unreachable secondary is worse than the total it replaced.
  it("names a roster member the reading does not speak for", () => {
    const split = usageSplit(
      usage([
        { member: "a:27017", ops: 100 },
        { member: "b:27017", ops: 100 },
      ]),
      THREE_ANSWERED,
    );
    expect(split?.blindSpots).toEqual(["c:27017"]);
    // And it stays out of the ratio: two of two ANSWERED, plus a named absence.
    expect(usageLine(present(split, "the split usage"))).toBe("200 ops · 2 of 2 nodes");
    expect(usageDetail(present(split, "the split usage"), "2026-08-11T09:00:00.000Z")).toContain(
      "c:27017 — not reported by the last collect",
    );
  });

  // The net guard declining an address is a policy fact, and it is still a
  // member this reading does not cover.
  it("counts a refused member as a blind spot too", () => {
    const split = usageSplit(
      usage([{ member: "a:27017", ops: 100 }]),
      roster([
        { host: "a:27017", role: "primary", state: "answered" },
        { host: "b:27017", role: "unknown", state: "refused" },
      ]),
    );
    expect(split?.blindSpots).toEqual(["b:27017"]);
  });

  // No roster is not evidence of full coverage — but it is also not evidence of
  // a gap, so nothing is claimed either way.
  it("claims no blind spots when the roster has not answered", () => {
    const split = usageSplit(usage([{ member: "a:27017", ops: 100 }]), null);
    expect(split?.blindSpots).toEqual([]);
  });

  it("has nothing to say about an index the last collect did not see", () => {
    expect(usageSplit(undefined, THREE_ANSWERED)).toBeNull();
  });

  it("says so when a reading exists and no member reported", () => {
    const split = usageSplit(usage([]), THREE_ANSWERED);
    expect(usageLine(present(split, "the split usage"))).toBe("no member reported this index");
  });
});

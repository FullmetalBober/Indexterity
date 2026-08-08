import { describe, expect, it } from "vitest";
import { membersFromHello, nodeFromHello } from "./connection";

// The shape a real 5-member 8.0 set answered with — primary, two priority-1
// secondaries, one priority-0 secondary, one hidden. Reading `hosts` alone found
// three of the five, which is how a cross-region secondary's index usage went
// uncollected (#99).
const FIVE_MEMBER_SET = {
  hosts: ["a:27017", "b:27017", "c:27017"],
  passives: ["d:27017"],
  setName: "rs0",
};

describe("membersFromHello", () => {
  // The whole bug in one assertion: priority 0 is the standard setting for a
  // secondary in another region, and priority 0 means `passives`, not `hosts`.
  it("takes the passives as well as the hosts", () => {
    expect(membersFromHello(FIVE_MEMBER_SET)).toEqual(["a:27017", "b:27017", "c:27017", "d:27017"]);
  });

  it("still reads a set that has no passive member", () => {
    expect(membersFromHello({ hosts: ["a:27017", "b:27017"] })).toEqual(["a:27017", "b:27017"]);
  });

  // A set that is nothing but a primary and a priority-0 standby. Under the old
  // read this returned one host, which MemberConnections treats as "not a replica
  // set" and skips entirely.
  it("finds a member when every secondary is passive", () => {
    expect(membersFromHello({ hosts: ["a:27017"], passives: ["b:27017"] })).toEqual([
      "a:27017",
      "b:27017",
    ]);
  });

  // A mongos has neither array — its shards answer the fan-out — and a standalone
  // has no set at all. Both must cost nothing rather than throw.
  it("is empty for a mongos, a standalone and a malformed reply", () => {
    expect(membersFromHello({ msg: "isdbgrid", ismaster: true })).toEqual([]);
    expect(membersFromHello({ ismaster: true })).toEqual([]);
    expect(membersFromHello(null)).toEqual([]);
    expect(membersFromHello("not a document")).toEqual([]);
  });

  it("ignores non-string entries rather than dialling them", () => {
    expect(membersFromHello({ hosts: ["a:27017", 42, null], passives: [{ host: "b" }] })).toEqual([
      "a:27017",
    ]);
  });

  // The arrays are documented as disjoint. If a server ever disagrees, a repeated
  // host must not cost a second direct connection every collect.
  it("names a host once even if both arrays claim it", () => {
    expect(membersFromHello({ hosts: ["a:27017"], passives: ["a:27017"] })).toEqual(["a:27017"]);
  });
});

// The roster's per-node row (#100): what one node's own hello admits to. The
// same replies membersFromHello reads, asked a different question.
describe("nodeFromHello", () => {
  it("names a replica-set primary and secondary by their own answers", () => {
    expect(nodeFromHello({ ...FIVE_MEMBER_SET, isWritablePrimary: true, me: "a:27017" })).toEqual({
      me: "a:27017",
      role: "primary",
    });
    expect(nodeFromHello({ ...FIVE_MEMBER_SET, secondary: true, me: "d:27017" })).toEqual({
      me: "d:27017",
      role: "secondary",
    });
  });

  // A hidden member answers `secondary` on a direct connection — hidden
  // governs routing, not identity — so a roster row for one is still honest.
  it("does not need a member to be electable to name it", () => {
    expect(nodeFromHello({ setName: "rs0", secondary: true, passive: true }).role).toBe(
      "secondary",
    );
  });

  it("tells a mongos and a standalone apart from set members", () => {
    expect(nodeFromHello({ msg: "isdbgrid", isWritablePrimary: true }).role).toBe("mongos");
    expect(nodeFromHello({ isWritablePrimary: true }).role).toBe("standalone");
  });

  // A member mid-election answers neither primary nor secondary; a malformed
  // reply answers nothing. Both are "unknown", never a guess.
  it("says unknown rather than guessing", () => {
    expect(nodeFromHello({ setName: "rs0" }).role).toBe("unknown");
    expect(nodeFromHello(null)).toEqual({ me: null, role: "unknown" });
    expect(nodeFromHello("not a document")).toEqual({ me: null, role: "unknown" });
  });
});

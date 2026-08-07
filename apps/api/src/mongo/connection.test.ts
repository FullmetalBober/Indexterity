import { describe, expect, it } from "vitest";
import { membersFromHello } from "./connection";

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

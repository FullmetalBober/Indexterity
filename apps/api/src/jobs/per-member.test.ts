import { describe, expect, it } from "vitest";
import { decodeMembers } from "./per-member";

// The wire form of `per_member` is not its stored form (#474): the hostname is
// interned against a dictionary and the objects travel as arrays. Everything the
// counter-restart rule reads comes back through here, so a decode that is wrong
// is a wrong `ops` handed to the gate that decides whether an index is used —
// which is why every element is checked rather than trusted.
const DICTIONARY = ["shard-00-00.example.net:27017", "shard-00-01.example.net:27017"];

describe("decoding compacted per-member usage", () => {
  it("resolves a position back to its member name", () => {
    expect(decodeMembers([[88388, "2026-08-27T13:48:06.307Z", 0]], DICTIONARY)).toEqual([
      { member: "shard-00-00.example.net:27017", ops: 88388, since: "2026-08-27T13:48:06.307Z" },
    ]);
  });

  it("takes the member name inline when the encoder could not intern it", () => {
    // The dictionary and the rows are two statements, so a collect landing
    // between them can introduce a member the first read never saw. The encoder
    // falls back to the name; losing which member a reading belongs to would
    // corrupt the restart comparison silently.
    expect(decodeMembers([[7, null, "shard-00-09.example.net:27017"]], DICTIONARY)).toEqual([
      { member: "shard-00-09.example.net:27017", ops: 7 },
    ]);
  });

  it("keeps `since` absent rather than null when the counter start is unknown", () => {
    // `MemberUsage.since` is optional, and the epoch rules already treat absent
    // as "cannot testify". Carrying a null through would make `typeof since`
    // checks downstream read a value that is not one.
    const [only] = decodeMembers([[0, null, 0]], DICTIONARY);
    expect(only).toEqual({ member: "shard-00-00.example.net:27017", ops: 0 });
    expect("since" in (only ?? {})).toBe(false);
  });

  it("decodes every member of a multi-member reading", () => {
    expect(
      decodeMembers(
        [
          [10, "2026-08-27T13:48:06.307Z", 0],
          [20, "2026-08-27T13:42:33.280Z", 1],
        ],
        DICTIONARY,
      ),
    ).toEqual([
      { member: "shard-00-00.example.net:27017", ops: 10, since: "2026-08-27T13:48:06.307Z" },
      { member: "shard-00-01.example.net:27017", ops: 20, since: "2026-08-27T13:42:33.280Z" },
    ]);
  });

  it("reads an index with no members as none", () => {
    // `jsonb_agg` over an empty array is NULL, which the encoder coalesces to
    // `[]`; both have to arrive as an empty list rather than as a throw.
    expect(decodeMembers([], DICTIONARY)).toEqual([]);
    expect(decodeMembers(null, DICTIONARY)).toEqual([]);
  });

  it("drops an element it cannot decode rather than guessing at it", () => {
    // A position past the end of the dictionary, a non-numeric ops, a short
    // tuple, a non-array. None of these can happen from the encoder; what
    // matters is that the failure mode is a missing reading and not a made-up
    // one, because a fabricated `ops` is indistinguishable from a real counter.
    expect(
      decodeMembers(
        [[1, null, 99], ["lots", null, 0], [5, null], "nonsense", [3, null, 1]],
        DICTIONARY,
      ),
    ).toEqual([{ member: "shard-00-01.example.net:27017", ops: 3 }]);
  });

  it("keeps a zero reading, which is a measurement and not an absence", () => {
    // An index nobody has used reports 0, and that row is the whole basis of a
    // drop finding — filtering it as falsy would delete the evidence.
    expect(decodeMembers([[0, "2026-08-27T13:48:06.307Z", 1]], DICTIONARY)).toEqual([
      { member: "shard-00-01.example.net:27017", ops: 0, since: "2026-08-27T13:48:06.307Z" },
    ]);
  });
});

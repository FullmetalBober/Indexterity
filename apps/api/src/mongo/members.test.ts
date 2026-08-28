import { describe, expect, it, vi } from "vitest";
import type { MongoConnection } from "./connection";
import { MemberConnections } from "./members";

// Which members get dialled at all, which is a guard question before it is a
// networking one.
//
// The dial itself needs a live set and the integration suite does it. What is
// pinned here is the decision in front of it: a member the cluster named is
// user-influenced input, and it has to be judged through the SAME branch of the
// guard the cluster's own connection took.

// A member dial that fails at once, so a test can tell "the guard allowed it and
// the socket did not answer" (`unreachable`) from "the guard refused it"
// (`refused`) without waiting out a TCP timeout to a private address.
vi.mock("./connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connection")>();
  return {
    ...actual,
    MongoConnection: class {
      connect(): Promise<void> {
        return Promise.reject(new Error("no server in a unit test"));
      }
    },
  };
});

const CONN = "mongodb://user:pw@primary.internal:27017/?tls=true";

// Answers only what the dialer asks: the member list, and what the live client
// resolved (an SRV string's tls and authSource, which a retargeted string would
// otherwise lose).
function primaryWith(hosts: string[]) {
  return {
    replicaMembers: () => Promise.resolve(hosts),
    resolved: () => undefined,
  } as unknown as MongoConnection;
}

describe("MemberConnections", () => {
  it("dials nothing on a standalone — one host is not a set", async () => {
    const members = new MemberConnections(primaryWith(["primary.internal:27017"]), CONN);
    expect(await members.dials()).toEqual([]);
    expect(await members.all()).toEqual([]);
  });

  // #382. A set behind a tunnel is made entirely of private addresses, so
  // judging its members with the DIRECT guard refused every one of them — and
  // the roster then said "refused", which reads like a member that is down
  // rather than like our own guard.
  describe("a set reached through a tunnel", () => {
    const HOSTS = ["10.4.5.6:27017", "10.4.5.7:27017"];

    it("judges a member against the peering's AllowedIPs, not the private flag", async () => {
      const members = new MemberConnections(primaryWith(HOSTS), CONN, undefined, undefined, {
        allowedIps: ["10.0.0.0/8"],
        resolve: () => Promise.reject(new Error("not asked: the member list carries addresses")),
      });

      // `unreachable` rather than `refused`: the guard allowed both and the dial
      // is what failed, which is the distinction the bug destroyed.
      expect(await members.dials()).toEqual([
        { host: "10.4.5.6:27017", state: "unreachable", connection: null },
        { host: "10.4.5.7:27017", state: "unreachable", connection: null },
      ]);
    });

    it("still refuses a member the peering did not agree to carry", async () => {
      const members = new MemberConnections(primaryWith(HOSTS), CONN, undefined, undefined, {
        // This peer routes 192.168/16 and the set named 10.4.5.x, so neither
        // member is inside what the peer agreed to carry.
        allowedIps: ["192.168.0.0/16"],
        resolve: () => Promise.reject(new Error("not asked")),
      });

      expect(await members.dials()).toEqual([
        { host: "10.4.5.6:27017", state: "refused", connection: null },
        { host: "10.4.5.7:27017", state: "refused", connection: null },
      ]);
    });

    // Cloud metadata is refused whatever route reaches it, which is the rule the
    // direct path applies too. A peering whose AllowedIPs covers it is a
    // misconfiguration, not a grant.
    it("refuses a forbidden address even when AllowedIPs covers it", async () => {
      const members = new MemberConnections(
        primaryWith(["169.254.169.254:27017", "10.4.5.6:27017"]),
        CONN,
        undefined,
        undefined,
        {
          allowedIps: ["0.0.0.0/0"],
          resolve: () => Promise.reject(new Error("not asked")),
        },
      );

      const dials = await members.dials();
      expect(dials[0]).toEqual({
        host: "169.254.169.254:27017",
        state: "refused",
        connection: null,
      });
      // And the rest of the set is unaffected: one refused member does not stop
      // the walk.
      expect(dials[1]?.state).toBe("unreachable");
    });
  });
});

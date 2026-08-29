import { describe, expect, it, vi } from "vitest";
import type { MssqlConnection, MssqlReplica } from "./connection";
import { MssqlMemberConnections } from "./members";

// A replica dial that fails at once, so a test can tell "the guard allowed it and
// the socket did not answer" (`unreachable`) from "the guard refused it"
// (`refused`) without waiting out a TCP timeout to a private address. Every test
// above this mock ends before a dial, so nothing else is affected by it.
vi.mock("./connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connection")>();
  return {
    ...actual,
    MssqlConnection: class {
      connect(): Promise<void> {
        return Promise.reject(new Error("no server in a unit test"));
      }
    },
  };
});

// A base connection that answers only what the dialer asks it: the replica
// catalog. Dialling itself is not exercised here — that needs two live servers,
// and the integration suite does it (#202).
function baseWith(replicas: MssqlReplica[] | Error) {
  return {
    availabilityReplicas: () =>
      replicas instanceof Error ? Promise.reject(replicas) : Promise.resolve(replicas),
  } as MssqlConnection;
}

function replica(overrides: Partial<MssqlReplica> = {}): MssqlReplica {
  return {
    name: "ag2",
    routingUrl: "tcp://ag2:1433",
    secondaryAllows: 2,
    isLocal: false,
    ...overrides,
  };
}

const CONN = "mssql://sa:pw@ag1:1433?trustservercertificate=true";

describe("MssqlMemberConnections", () => {
  it("dials nothing on a standalone — the catalog names no replicas", async () => {
    const members = new MssqlMemberConnections(baseWith([]), CONN);
    expect(await members.dials()).toEqual([]);
    expect(await members.all()).toEqual([]);
  });

  it("skips the local replica: the base connection already speaks for it", async () => {
    const members = new MssqlMemberConnections(
      baseWith([replica({ name: "ag1", isLocal: true })]),
      CONN,
    );
    expect(await members.dials()).toEqual([]);
  });

  // A login that cannot read the catalog view gets a smaller cluster picture,
  // not a failed collect.
  it("reports no members when the catalog cannot be read", async () => {
    const members = new MssqlMemberConnections(baseWith(new Error("permission denied")), CONN);
    expect(await members.dials()).toEqual([]);
  });

  it("refuses a replica that does not accept read connections", async () => {
    const members = new MssqlMemberConnections(baseWith([replica({ secondaryAllows: 0 })]), CONN);
    expect(await members.dials()).toEqual([{ host: "ag2", state: "refused", connection: null }]);
  });

  // The instance name is not an address — `HOST\INSTANCE` least of all — and
  // guessing one is how a collector dials the wrong machine.
  it("refuses a replica the group gave no routing URL for", async () => {
    const members = new MssqlMemberConnections(
      baseWith([replica({ routingUrl: null }), replica({ name: "ag3", routingUrl: "ag3" })]),
      CONN,
    );
    expect(await members.dials()).toEqual([
      { host: "ag2", state: "refused", connection: null },
      { host: "ag3", state: "refused", connection: null },
    ]);
  });

  it("dials once and reuses the result", async () => {
    let reads = 0;
    const base = {
      availabilityReplicas: () => {
        reads += 1;
        return Promise.resolve([replica({ secondaryAllows: 0 })]);
      },
    } as MssqlConnection;
    const members = new MssqlMemberConnections(base, CONN);
    await members.dials();
    await members.dials();
    expect(reads).toBe(1);
  });
});

// #382. A group behind a tunnel is made of private addresses, so judging its
// replicas with the DIRECT guard refused every one of them — and the roster said
// "refused", which reads like a replica that is down rather than our own guard.
describe("a group reached through a tunnel", () => {
  const PRIVATE = replica({ name: "ag2", routingUrl: "tcp://10.4.5.6:1433" });

  it("judges a replica against the peering's AllowedIPs, not the private flag", async () => {
    const members = new MssqlMemberConnections(baseWith([PRIVATE]), CONN, undefined, undefined, {
      allowedIps: ["10.0.0.0/8"],
      resolve: () => Promise.reject(new Error("not asked: the routing URL is an address")),
    });

    // `unreachable` rather than `refused`: the guard allowed it and the dial is
    // what failed, which is the whole distinction the bug destroyed.
    expect(await members.dials()).toEqual([
      { host: "ag2", state: "unreachable", connection: null },
    ]);
  });

  it("still refuses a replica the peering did not agree to carry", async () => {
    const members = new MssqlMemberConnections(baseWith([PRIVATE]), CONN, undefined, undefined, {
      // The group named 10.4.5.6 and this peer carries only 192.168.0.0/16, so
      // the address is outside what the peer agreed to route.
      allowedIps: ["192.168.0.0/16"],
      resolve: () => Promise.reject(new Error("not asked")),
    });

    expect(await members.dials()).toEqual([{ host: "ag2", state: "refused", connection: null }]);
  });
});

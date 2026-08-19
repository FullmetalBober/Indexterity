import { describe, expect, it } from "vitest";
import type { MssqlConnection, MssqlReplica } from "./connection";
import { MssqlMemberConnections } from "./members";

// A base connection that answers only what the dialer asks it: the replica
// catalog. Dialling itself is not exercised here — that needs two live servers,
// and the integration suite does it (#202).
function baseWith(replicas: MssqlReplica[] | Error) {
  return {
    availabilityReplicas: () =>
      replicas instanceof Error ? Promise.reject(replicas) : Promise.resolve(replicas),
  } as unknown as MssqlConnection;
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
    } as unknown as MssqlConnection;
    const members = new MssqlMemberConnections(base, CONN);
    await members.dials();
    await members.dials();
    expect(reads).toBe(1);
  });
});

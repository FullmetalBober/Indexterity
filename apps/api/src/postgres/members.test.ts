import { describe, expect, it } from "vitest";
import { collectPostgresNodes, type PostgresNodeSource } from "./members";

// A complete PostgresNodeSource, because what is being asserted is the roster
// builds from two answers — not the SQL, which the live probe covers.
function stub(options: {
  inRecovery?: boolean;
  replicas?: { host: string | null; state: string | null }[];
  throws?: boolean;
}): PostgresNodeSource {
  return {
    serverIdentity: async () => {
      if (options.throws === true) throw new Error("unreachable");
      return {
        member: "db.corp:5432",
        startedAt: "",
        statsReset: null,
        inRecovery: options.inRecovery ?? false,
        version: null,
      };
    },
    // No assertion: the port fixes the row, so this answers ReplicaRows.
    query: async () => options.replicas ?? [],
  };
}

describe("collectPostgresNodes", () => {
  it("reports a single primary as itself", async () => {
    expect(await collectPostgresNodes(stub({}))).toEqual([
      { host: "db.corp:5432", role: "primary", state: "answered" },
    ]);
  });

  // Read live rather than assumed: a failover changes this and nothing else
  // about the connection.
  it("calls a server in recovery a secondary", async () => {
    const nodes = await collectPostgresNodes(stub({ inRecovery: true }));
    expect(nodes).toEqual([{ host: "db.corp:5432", role: "secondary", state: "answered" }]);
  });

  // A standby is the one being replicated TO, so it has no replicas of its own
  // to report and must not be asked.
  it("does not look for replicas from a standby", async () => {
    const nodes = await collectPostgresNodes(
      stub({ inRecovery: true, replicas: [{ host: "10.0.0.9", state: "streaming" }] }),
    );
    expect(nodes).toHaveLength(1);
  });

  // Reported, not dialled. pg_stat_replication's client_addr is the address the
  // standby's WAL receiver connected FROM — not a promise it can be dialled back
  // — and PostgreSQL publishes no routing URL the way SQL Server does. So the
  // replica appears with "refused", which is the port's word for "this
  // deployment did not dial it", rather than "unreachable", which would claim a
  // failed attempt.
  it("lists a replica as refused rather than pretending it was read", async () => {
    const nodes = await collectPostgresNodes(
      stub({ replicas: [{ host: "10.0.0.9", state: "streaming" }] }),
    );
    expect(nodes).toEqual([
      { host: "db.corp:5432", role: "primary", state: "answered" },
      { host: "10.0.0.9", role: "secondary", state: "refused" },
    ]);
  });

  it("skips a replica with no address at all", async () => {
    const nodes = await collectPostgresNodes(
      stub({
        replicas: [
          { host: null, state: "streaming" },
          { host: "  ", state: "streaming" },
        ],
      }),
    );
    expect(nodes).toHaveLength(1);
  });

  // Null rather than a one-node roster: on a cluster that has replicas, "just
  // me" is the one answer a reader would take as "we saw everything".
  it("answers null when even the roster could not be established", async () => {
    expect(await collectPostgresNodes(stub({ throws: true }))).toBeNull();
  });
});

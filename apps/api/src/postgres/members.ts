import type { QueryResultRow } from "pg";
import type { ClusterNode } from "../engine/ports";
import type { PostgresServerIdentity } from "./connection";

// Every node this collect could see, and how each answered (#100).
//
// The reason this file exists at all is the same on all three engines: usage
// counters are PER NODE. A standby keeps its own `idx_scan`, so an index idle on
// the primary may be the one a reporting replica lives on, and dropping it on
// that evidence takes out the replica's workload.
//
// What differs here is that PostgreSQL will not tell us how to reach its
// standbys. `pg_stat_replication` on the primary lists each connected one, but
// its `client_addr` is the address the standby's WAL RECEIVER connected FROM —
// an outbound socket, frequently on a private interface, and never a promise
// that a client can dial it back on 5432. SQL Server publishes a read-only
// routing URL for exactly this and PostgreSQL publishes nothing equivalent.
//
// So a replica is REPORTED and not dialled. It appears in the roster with the
// address the primary saw, so a reader can tell that the cluster has one and
// that its counters were not included — which is the honest version of #202 on
// this engine, and better than a roster of one that implies the whole cluster was
// read.
/** The one row this file reads, named so the port can be fixed to it. */
interface ReplicaRow extends QueryResultRow {
  host: string | null;
  state: string | null;
}

/**
 * Two of a Postgres connection's members: who this node is, and one read.
 *
 * `query` is fixed to the row rather than generic on the method. A generic
 * `query<T>` promises rows of whatever type the caller asks for, and the only
 * value assignable to `T[]` for every `T` is `[]` — so any fake carrying real
 * data has to assert. Fixed here, the fake just answers ReplicaRows, and the
 * real connection's generic `query` still satisfies it.
 */
export interface PostgresNodeSource {
  query(text: string, params?: readonly unknown[], database?: string): Promise<ReplicaRow[]>;
  serverIdentity(): Promise<PostgresServerIdentity>;
}

export async function collectPostgresNodes(
  conn: PostgresNodeSource,
): Promise<readonly ClusterNode[] | null> {
  try {
    const identity = await conn.serverIdentity();
    const self: ClusterNode = {
      host: identity.member,
      // A server in recovery is a standby, whatever it was when the string was
      // pasted. Read live rather than assumed: a failover changes this and
      // nothing else about the connection.
      role: identity.inRecovery ? "secondary" : "primary",
      state: "answered",
    };
    // A standby has no pg_stat_replication rows of its own to speak of (it is
    // the one being replicated to), so the roster from there is just itself.
    if (identity.inRecovery) return [self];

    const replicas = await conn.query(
      `SELECT COALESCE(host(client_addr)::text, application_name) AS host, state
         FROM pg_stat_replication`,
    );
    const nodes: ClusterNode[] = [self];
    for (const replica of replicas) {
      const host = (replica.host ?? "").trim();
      if (host.length === 0) continue;
      nodes.push({
        host,
        role: "secondary",
        // "refused" is the honest state, and it is deliberately not
        // "unreachable": nothing was dialled. This deployment does not dial a
        // replica PostgreSQL gave it no dialable address for, which is a policy
        // decision rather than a fact about the node's health — the same meaning
        // the port assigns the word for a net-guard refusal.
        state: "refused",
      });
    }
    return nodes;
  } catch {
    // Even the roster could not be established. Null rather than a guess: a
    // single-node roster on a cluster that has replicas is the one answer that
    // would be read as "we saw everything".
    return null;
  }
}

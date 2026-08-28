import {
  allowPrivateTargets,
  assertDialTargetsAllowed,
  type TunnelRoute,
} from "../engine/net-guard";
import type { DialProxy, TlsOverrides } from "../engine/ports";
import { parseMssqlConnString, parseRoutingUrl, retargetMssqlConnString } from "./conn-string";
import { MssqlConnection } from "./connection";

// One replica's dial, kept whether or not it worked — the mssql twin of
// mongo/members.ts, and the states mean exactly what they mean there:
//
//   answered    — dialled and connected; the connection is live
//   unreachable — the dial failed (down, seeding, endpoint closed)
//   refused     — we would not dial the address the group named: either this
//                 deployment's net guard declined it, or the replica does not
//                 accept read connections at all, or the group gave no
//                 routing URL and its bare instance name is not an address.
//                 A fact about the arrangement, never about the node's health
export type MssqlMemberState = "answered" | "unreachable" | "refused";

export interface MssqlMemberDial {
  // The replica's own name (replica_server_name = its @@SERVERNAME), which is
  // the key usage rows are tagged with — not the address dialled, so a roster
  // entry and its usage readings line up.
  readonly host: string;
  readonly state: MssqlMemberState;
  readonly connection: MssqlConnection | null;
}

// Per-replica connections for usage collection.
//
// `sys.dm_db_index_usage_stats` counts the reads THIS instance served, and an
// Availability Group's readable secondaries serve their own — the reporting
// traffic pointed at them with ApplicationIntent=ReadOnly is exactly the shape
// that makes an index look dead from the primary. Measured on a two-node group
// (2022, CLUSTER_TYPE = NONE): three seeks run on the secondary reported
// user_seeks = 3 there and 0 on the primary, for the same index in the same
// database. Dropping it would have been invisible to the regression gate too,
// which reads the primary's Query Store.
//
// So: ask the instance for its group's replicas and open a direct connection to
// each of the others. A standalone names none, and costs one cheap query.
export class MssqlMemberConnections {
  private dialled: MssqlMemberDial[] | null = null;

  constructor(
    private readonly base: MssqlConnection,
    private readonly connString: string,
    private readonly overrides?: TlsOverrides,
    // Where a replica's socket goes, and what its address is judged against.
    // Both absent for a group dialled directly, which is the common case.
    private readonly proxy?: DialProxy,
    private readonly route?: TunnelRoute,
  ) {}

  async all(): Promise<MssqlConnection[]> {
    return (await this.dials())
      .map((dial) => dial.connection)
      .filter((conn): conn is MssqlConnection => conn !== null);
  }

  // Every replica besides the one the base connection is already on, and how
  // each dial went. Opened once and reused for the life of the session, so a
  // three-replica group costs three connections rather than three per collect.
  async dials(): Promise<readonly MssqlMemberDial[]> {
    if (this.dialled !== null) return this.dialled;
    this.dialled = [];
    // A login without VIEW ANY DEFINITION cannot read the catalog view. That is
    // a smaller cluster picture, not a failed collect: the base connection still
    // reports everything it did before.
    const replicas = await this.base.availabilityReplicas().catch(() => []);
    const defaultPort = parseMssqlConnString(this.connString)?.port;

    for (const replica of replicas) {
      if (replica.isLocal) continue;
      // ALLOW_CONNECTIONS = NO. The replica exists and is healthy; it simply
      // serves nothing, so it has no counters to contribute and never will.
      if (replica.secondaryAllows === 0) {
        this.dialled.push({ host: replica.name, state: "refused", connection: null });
        continue;
      }
      const route = parseRoutingUrl(replica.routingUrl);
      // Without a routing URL all the group offers is an instance name, which
      // is an address only if it happens to also be a hostname on the default
      // port — and a named instance (`HOST\INSTANCE`) is not one at all.
      // Guessing is how a collector ends up dialling the wrong machine.
      if (route === null) {
        this.dialled.push({ host: replica.name, state: "refused", connection: null });
        continue;
      }
      const target = `${route.host}:${route.port === 0 ? (defaultPort ?? 1433) : route.port}`;
      // The routing URL comes from the cluster, so it is user-influenced input
      // like any connection string and goes through the same guard — and through
      // the SAME BRANCH of it the group's own connection took.
      //
      // That was the bug (#382): this called the direct guard unconditionally, so
      // a group behind a tunnel had every replica refused for being private, and
      // the roster said "refused" where the cause was our own guard.
      const allowed = await assertDialTargetsAllowed(
        [target],
        false,
        this.route === undefined
          ? { kind: "direct", allowPrivate: allowPrivateTargets() }
          : { kind: "tunnel", ...this.route },
      )
        .then(() => true)
        .catch(() => false);
      if (!allowed) {
        this.dialled.push({ host: replica.name, state: "refused", connection: null });
        continue;
      }
      try {
        const conn = new MssqlConnection(
          retargetMssqlConnString(this.connString, route.host, route.port),
          this.overrides,
          // A READ_ONLY replica refuses a plain connection (Msg 978) and an ALL
          // replica accepts read intent, so every member dial declares it. The
          // proxy rides along: judging a replica correctly and then dialling it
          // outside the tunnel is the same bug wearing the other hat.
          this.proxy === undefined
            ? { readOnlyIntent: true }
            : { readOnlyIntent: true, proxy: this.proxy },
        );
        await conn.connect();
        this.dialled.push({ host: replica.name, state: "answered", connection: conn });
      } catch {
        // A replica that is down, seeding, or has its endpoint closed is
        // normal: the others still report, and a missing replica's counters
        // simply do not contribute. Recorded rather than swallowed, so the
        // roster can say so.
        this.dialled.push({ host: replica.name, state: "unreachable", connection: null });
      }
    }
    return this.dialled;
  }

  async close(): Promise<void> {
    for (const dial of this.dialled ?? []) {
      if (dial.connection !== null) await dial.connection.close().catch(() => {});
    }
    this.dialled = null;
  }
}

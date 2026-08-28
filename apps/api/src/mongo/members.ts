import {
  allowPrivateTargets,
  assertDialTargetsAllowed,
  type TunnelRoute,
} from "../engine/net-guard";
import type { DialProxy, TlsOverrides } from "../engine/ports";
import { directConnectionTo } from "./conn-string";
import { MongoConnection } from "./connection";

// One member's dial, kept whether or not it worked (#100). `connection` is
// null exactly when `state` says why there is not one.
//
//   answered    — dialled and connected; the connection is live
//   unreachable — the dial failed (down, partitioned, DNS gone)
//   refused     — the net guard would not let us dial the address the cluster
//                 named; a policy fact about this deployment, not a health
//                 fact about the member
export type MemberState = "answered" | "unreachable" | "refused";

export interface MemberDial {
  readonly host: string;
  readonly state: MemberState;
  readonly connection: MongoConnection | null;
}

// Per-member connections for usage collection.
//
// `$indexStats` reports for the node that executes it, and the driver sends
// reads to the primary. So a single connection sees the primary's counters and
// nothing else — an index serving only secondary reads (the standard shape for
// analytics and reporting traffic, `readPreference=secondaryPreferred`) looks
// completely idle. Dropping it would be invisible to the regression gate too,
// because `$collStats` latency is equally node-local.
//
// So: ask the cluster for its members and open a direct connection to each.
// A standalone reports none, and a mongos reports none of its own (its shards'
// primaries answer the fan-out already), so both cost nothing.
export class MemberConnections {
  private dialled: MemberDial[] | null = null;

  constructor(
    private readonly primary: MongoConnection,
    private readonly connString: string,
    private readonly overrides?: TlsOverrides,
    // How this cluster is REACHED, when it is not simply reachable. Both halves
    // are needed and for different reasons: the proxy is where a member's socket
    // goes, and the route is what a member's address is judged against. Absent
    // for every cluster dialled directly, which is the common case.
    private readonly proxy?: DialProxy,
    private readonly route?: TunnelRoute,
  ) {}

  // Connections to every member the set admits to (including the address the
  // primary client is already on — $indexStats dedupes by host downstream).
  // Opened once and reused for the life of the session.
  async all(): Promise<MongoConnection[]> {
    return (await this.dials())
      .map((dial) => dial.connection)
      .filter((conn): conn is MongoConnection => conn !== null);
  }

  // Every dial and how it went, which used to be a silent catch: every member
  // failing for the same systematic reason looked exactly like a standalone
  // for as long as SRV clusters have been supported, and nothing said so. The
  // roster (#100) is built from this. Empty for a standalone and a mongos —
  // neither names members, and the base connection speaks for itself.
  async dials(): Promise<readonly MemberDial[]> {
    if (this.dialled !== null) return this.dialled;
    this.dialled = [];
    const hosts = await this.primary.replicaMembers().catch(() => []);
    if (hosts.length <= 1) return this.dialled;

    // Taken from the LIVE client, not from the string it was built with. An SRV
    // string carries its tls default in the scheme and its authSource in a DNS
    // TXT record, and retargeting it at one host loses both — see
    // directConnectionTo. `this.primary` is connected by the time anything asks
    // for members, so the TXT record has already been read and merged.
    const resolved = this.primary.resolved();

    for (const host of hosts) {
      // The member list comes from the cluster, which means a hostile or
      // misconfigured one could name an address we must not dial. It is
      // user-influenced input like any connection string, so it goes through
      // the same guard — and through the SAME BRANCH of it the cluster's own
      // connection took.
      //
      // That last part was the bug (#382). This called the direct guard
      // unconditionally, and a tunnelled replica set is made entirely of private
      // addresses, so with ALLOW_PRIVATE_CLUSTER_TARGETS off — the default, and
      // the right one — every member was refused and only the base connection
      // ever contributed. Nothing said so: the roster showed members as refused,
      // which reads like an unreachable node rather than our own guard.
      const ok = await assertDialTargetsAllowed(
        [host],
        false,
        this.route === undefined
          ? { kind: "direct", allowPrivate: allowPrivateTargets() }
          : { kind: "tunnel", ...this.route },
      )
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        this.dialled.push({ host, state: "refused", connection: null });
        continue;
      }
      try {
        // Through the same proxy the cluster's own connection uses. Judging a
        // member correctly and then dialling it outside the tunnel would be the
        // same bug wearing the other hat: the address is only reachable in there.
        const conn = new MongoConnection(
          directConnectionTo(this.connString, host, resolved),
          this.overrides,
          this.proxy,
        );
        await conn.connect();
        this.dialled.push({ host, state: "answered", connection: conn });
      } catch {
        // A member that is down or unreachable is normal: the others still
        // report, and a missing member's counters simply do not contribute.
        // Recorded rather than swallowed, so the roster can say so.
        this.dialled.push({ host, state: "unreachable", connection: null });
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

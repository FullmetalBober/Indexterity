import { allowPrivateTargets, assertTargetsAllowed } from "../engine/net-guard";
import type { TlsOverrides } from "../engine/ports";
import { directConnectionTo } from "./conn-string";
import { MongoConnection } from "./connection";

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
  private opened: MongoConnection[] | null = null;

  constructor(
    private readonly primary: MongoConnection,
    private readonly connString: string,
    private readonly overrides?: TlsOverrides,
  ) {}

  // Connections to every member except the one the primary client is already
  // talking to. Opened once and reused for the life of the session.
  async all(): Promise<MongoConnection[]> {
    if (this.opened !== null) return this.opened;
    this.opened = [];
    const hosts = await this.primary.replicaMembers().catch(() => []);
    if (hosts.length <= 1) return this.opened;

    // The member list comes from the cluster, which means a hostile or
    // misconfigured one could name an address we must not dial. It is
    // user-influenced input like any connection string, so it goes through the
    // same guard.
    const allowed: string[] = [];
    for (const host of hosts) {
      const ok = await assertTargetsAllowed([host], false, {
        allowPrivate: allowPrivateTargets(),
      })
        .then(() => true)
        .catch(() => false);
      if (ok) allowed.push(host);
    }

    // Taken from the LIVE client, not from the string it was built with. An SRV
    // string carries its tls default in the scheme and its authSource in a DNS
    // TXT record, and retargeting it at one host loses both — see
    // directConnectionTo. `this.primary` is connected by the time anything asks
    // for members, so the TXT record has already been read and merged.
    const resolved = this.primary.resolved();

    for (const host of allowed) {
      try {
        const conn = new MongoConnection(
          directConnectionTo(this.connString, host, resolved),
          this.overrides,
        );
        await conn.connect();
        this.opened.push(conn);
      } catch {
        // A member that is down or unreachable is normal: the others still
        // report, and a missing member's counters simply do not contribute.
        //
        // It is normal ONE AT A TIME. Every member failing for the same
        // systematic reason looked exactly like a standalone for as long as SRV
        // clusters have been supported, and nothing said so — the surfacing is
        // #100's, but the reason this catch could hide something that large is
        // worth knowing while reading it.
      }
    }
    return this.opened;
  }

  async close(): Promise<void> {
    for (const conn of this.opened ?? []) await conn.close().catch(() => {});
    this.opened = null;
  }
}

import { Injectable } from "@nestjs/common";
import type { TunnelView } from "@repo/contracts";
import { and, count, eq } from "drizzle-orm";
import { masterKeyBytesFor } from "../config/env";
import { clusters, envKeyProvider, open as openSealed, seal, tunnels } from "../db";
import { DatabaseService } from "../db/database.service";
import type { DialProxy } from "../engine/ports";
import { InvalidWireGuardConfError, parseWireGuardConf, type WireGuardConf } from "./conf";
import { TunnelRegistry } from "./tunnel.registry";

// Reads and writes the tunnel rows, and derives what the dashboard shows.
//
// The view is computed from the SEALED config every time rather than mirrored
// into columns. Two representations of one config drift, and the one that
// drifts silently is the AllowedIPs the guard enforces against — so the sealed
// blob stays the only copy and unsealing costs an AEAD decrypt per row.

export class TunnelInUseError extends Error {
  constructor(readonly clusterCount: number) {
    super(
      `this tunnel still reaches ${clusterCount} cluster${clusterCount === 1 ? "" : "s"} — ` +
        "point them somewhere else before removing it",
    );
    this.name = "TunnelInUseError";
  }
}

@Injectable()
export class TunnelService {
  constructor(
    private readonly database: DatabaseService,
    private readonly registry: TunnelRegistry,
  ) {}

  async list(orgId: string): Promise<TunnelView[]> {
    const rows = await this.database.db.select().from(tunnels).where(eq(tunnels.orgId, orgId));
    return Promise.all(rows.map((row) => this.#view(row)));
  }

  async create(orgId: string, name: string, config: string): Promise<TunnelView> {
    // Parsed BEFORE anything is stored, so a config that cannot work is refused
    // with the parser's own sentence rather than accepted and then failing at
    // the first dial, where the reason would be a timeout.
    const conf = parseWireGuardConf(config);
    const sealed = await seal(
      new TextEncoder().encode(config),
      envKeyProvider(masterKeyBytesFor(1)),
    );
    const [row] = await this.database.db
      .insert(tunnels)
      .values({
        orgId,
        name,
        sealedDek: Buffer.from(sealed.dek),
        sealedData: Buffer.from(sealed.data),
        keyVersion: 1,
      })
      .returning();
    if (row === undefined) throw new Error("insert returned no row");
    return this.#viewFrom(row.id, row.name, row.createdAt, conf);
  }

  async remove(tunnelId: string): Promise<void> {
    const using = await this.#clusterCount(tunnelId);
    // Checked here as well as by the FK, so the owner gets a sentence naming the
    // number rather than a foreign-key violation.
    if (using > 0) throw new TunnelInUseError(using);
    await this.database.db.delete(tunnels).where(eq(tunnels.id, tunnelId));
    // The live peering goes with the row; leaving it up would hold a socket and
    // a key for a tunnel nothing can reach any more.
    await this.registry.close(tunnelId);
  }

  /**
   * Bring the tunnel up and report both halves a dial needs: what the guard
   * will permit, and where the driver sends its packets.
   *
   * Used by the CONNECT path, which has no cluster row to resolve from yet —
   * the job pipeline goes through tunnel/resolve.ts instead, keyed on the
   * cluster's tunnel_id.
   */
  async openFor(tunnelId: string): Promise<{ allowedIps: string[]; proxy: DialProxy }> {
    const [row] = await this.database.db
      .select()
      .from(tunnels)
      .where(eq(tunnels.id, tunnelId))
      .limit(1);
    if (row === undefined) throw new Error("no such tunnel");
    const conf = parseWireGuardConf(
      new TextDecoder().decode(
        await openSealed(
          { dek: row.sealedDek, data: row.sealedData },
          envKeyProvider(masterKeyBytesFor(row.keyVersion)),
        ),
      ),
    );
    const endpoint = await this.registry.open(tunnelId, conf);
    return {
      allowedIps: [...conf.peer.allowedIps],
      proxy: {
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.credentials.username,
        password: endpoint.credentials.password,
      },
    };
  }

  /**
   * Does this tunnel belong to this org?
   *
   * One query matching BOTH, so a tunnel in another organization is
   * indistinguishable from one that does not exist — the same shape
   * assertOwnsCluster uses, and for the same reason: the difference is a fact
   * about somebody else's account.
   */
  async ownedBy(tunnelId: string, orgId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: tunnels.id })
      .from(tunnels)
      .where(and(eq(tunnels.id, tunnelId), eq(tunnels.orgId, orgId)))
      .limit(1);
    return row !== undefined;
  }

  async #clusterCount(tunnelId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(clusters)
      .where(eq(clusters.tunnelId, tunnelId));
    return row?.value ?? 0;
  }

  async #view(row: typeof tunnels.$inferSelect): Promise<TunnelView> {
    let conf: WireGuardConf | null = null;
    try {
      conf = parseWireGuardConf(
        new TextDecoder().decode(
          await openSealed(
            { dek: row.sealedDek, data: row.sealedData },
            envKeyProvider(masterKeyBytesFor(row.keyVersion)),
          ),
        ),
      );
    } catch (error) {
      // A row we can no longer read is a real state — a master key rotated
      // without its predecessor, say — and it must still be listable so the
      // owner can delete it. Blank fields say "unreadable" better than a 500
      // that hides every other tunnel too.
      if (!(error instanceof InvalidWireGuardConfError) && !(error instanceof Error)) throw error;
    }
    return this.#viewFrom(row.id, row.name, row.createdAt, conf);
  }

  async #viewFrom(
    id: string,
    name: string,
    createdAt: Date,
    conf: WireGuardConf | null,
  ): Promise<TunnelView> {
    const health = this.registry.health(id);
    return {
      id,
      name,
      endpoint: conf === null ? "" : `${conf.peer.endpoint.host}:${conf.peer.endpoint.port}`,
      allowedIps: conf === null ? [] : [...conf.peer.allowedIps],
      dns: conf === null ? [] : [...conf.dns],
      // No live tunnel is IDLE, not DOWN: tunnels come up on first use, so
      // "nobody has asked yet" is the normal state of a healthy new one and
      // drawing it as a fault would train owners to ignore the indicator.
      health:
        health === null
          ? "IDLE"
          : health.state === "up"
            ? "UP"
            : health.state === "handshaking"
              ? "HANDSHAKING"
              : "DOWN",
      handshakeAgeSeconds: health?.handshakeAgeSeconds ?? null,
      clusterCount: await this.#clusterCount(id),
      createdAt: createdAt.toISOString(),
    };
  }
}

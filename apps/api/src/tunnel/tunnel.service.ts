import { Injectable } from "@nestjs/common";
import type { TunnelHealth, TunnelTestResult, TunnelView } from "@repo/contracts";
import { and, count, eq } from "drizzle-orm";
import { masterKeyBytesFor } from "../config/env";
import { clusters, envKeyProvider, open as openSealed, seal, tunnels } from "../db";
import { DatabaseService } from "../db/database.service";
import type { TunnelRoute } from "../engine/net-guard";
import type { DialProxy } from "../engine/ports";
import type { TunnelState } from "./child";
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
    const [row] = await this.database.db
      .insert(tunnels)
      .values({ orgId, name, ...(await this.#seal(config)) })
      .returning();
    if (row === undefined) throw new Error("insert returned no row");
    return this.#viewFrom(row.id, row.name, row.createdAt, conf);
  }

  /**
   * Rename a tunnel, replace its config, or both.
   *
   * The two edits arrive separately by design. A rename never needs the config
   * re-pasted — and could not ask for it, since the stored PrivateKey is never
   * shown, so there is nothing the dashboard could prefill. A rotated key or a
   * moved gateway arrives as a whole new wg0.conf, which is what the VPN admin
   * exports anyway.
   */
  async update(
    tunnelId: string,
    patch: { name?: string; config?: string },
  ): Promise<{ tunnel: TunnelView; before: TunnelView }> {
    // Parsed BEFORE anything is stored, exactly as on create: a config that
    // cannot work is refused with the parser's own sentence rather than saved
    // and then failing at the next collect, where the reason would be a timeout.
    if (patch.config !== undefined) parseWireGuardConf(patch.config);

    // Read before the write, because the trail records both sides: what this
    // tunnel reached BEFORE a config was replaced is the question an incident
    // asks, and by then the only copy of it has been overwritten.
    const before = await this.#view(await this.#row(tunnelId));

    const [row] = await this.database.db
      .update(tunnels)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.config === undefined ? {} : await this.#seal(patch.config)),
        updatedAt: new Date(),
      })
      .where(eq(tunnels.id, tunnelId))
      .returning();
    if (row === undefined) throw new Error("update returned no row");

    if (patch.config !== undefined) {
      // The live peering is DROPPED rather than replaced in place. A stored
      // config and a running device that disagree is the one failure here that
      // is silent — every dial would keep using the key that was just rotated
      // away, and nothing would say so — and replacing carries that risk in
      // its own error path, since registry.open leaves the old tunnel up when
      // the new one cannot be built.
      //
      // Nothing is lost by dropping it: tunnels come up on first use, so the
      // next collect brings this one back from what is now stored, and an owner
      // who wants to see that happen has the reachability test.
      await this.registry.close(tunnelId);
    }
    return { tunnel: await this.#view(row), before };
  }

  /**
   * Bring the tunnel up and prove the gateway answers.
   *
   * The answer registering a tunnel cannot give: the parser reads the file, and
   * a mistyped PublicKey or a revoked peering is a perfectly valid file. See
   * reach.ts for why this forces a handshake rather than reading the state.
   */
  async test(tunnelId: string): Promise<{ verdict: TunnelTestResult; tunnel: TunnelView }> {
    // The row is read either way: the conf to open with, and the view the caller
    // needs to record what was tested. One read, rather than the caller listing
    // every tunnel in the org to find out this one's name.
    const row = await this.#row(tunnelId);

    // Opened only when it is not up already. A test must not tear down a
    // peering other clusters are collecting through — and it does not need to,
    // because the probe negotiates a fresh session on the live device either
    // way.
    if (this.registry.endpoint(tunnelId) === null) {
      await this.registry.open(tunnelId, await this.#unseal(row));
    }
    const reach = await this.registry.probe(tunnelId);
    return {
      verdict: {
        reachable: reach.reachable,
        health: toHealth(reach.state),
        handshakeAgeSeconds: reach.handshakeAgeSeconds,
        error: reach.error,
      },
      // Built AFTER the probe, so its health is the health the probe just
      // established rather than what it was a moment before.
      tunnel: await this.#view(row),
    };
  }

  /**
   * Returns what was removed, which the caller needs to record it: the row is
   * gone by the time the trail is written, and "a tunnel was removed" without
   * the gateway it reached answers nothing an incident asks.
   */
  async remove(tunnelId: string): Promise<TunnelView> {
    const removed = await this.#view(await this.#row(tunnelId));
    // Checked here as well as by the FK, so the owner gets a sentence naming the
    // number rather than a foreign-key violation.
    if (removed.clusterCount > 0) throw new TunnelInUseError(removed.clusterCount);
    await this.database.db.delete(tunnels).where(eq(tunnels.id, tunnelId));
    // The live peering goes with the row; leaving it up would hold a socket and
    // a key for a tunnel nothing can reach any more.
    await this.registry.close(tunnelId);
    return removed;
  }

  /**
   * Bring the tunnel up and report both halves a dial needs: what the guard
   * will permit, and where the driver sends its packets.
   *
   * Used by the CONNECT path, which has no cluster row to resolve from yet —
   * the job pipeline goes through tunnel/resolve.ts instead, keyed on the
   * cluster's tunnel_id.
   */
  async openFor(tunnelId: string): Promise<{ route: TunnelRoute; proxy: DialProxy }> {
    const conf = await this.#conf(tunnelId);
    // Reuse a tunnel that is already up rather than replacing it. registry.open
    // REPLACES by design — that is how a rotated key lands — so calling it
    // unconditionally meant a preflight followed by a connect tore down a
    // working peering and rebuilt it seconds later, dropping anything in
    // flight. Observed in the walkthrough as up → down → up between the two
    // steps of one connect.
    const endpoint = this.registry.endpoint(tunnelId) ?? (await this.registry.open(tunnelId, conf));
    return {
      route: {
        allowedIps: [...conf.peer.allowedIps],
        // Bound to this tunnel, so the guard resolves through the same peering
        // the dial will use rather than through ours.
        resolve: (host) => this.registry.resolve(tunnelId, host),
      },
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

  /** Envelope-encrypt a pasted config, in the columns the table wants it in. */
  async #seal(
    config: string,
  ): Promise<Pick<typeof tunnels.$inferInsert, "sealedDek" | "sealedData" | "keyVersion">> {
    const sealed = await seal(
      new TextEncoder().encode(config),
      envKeyProvider(masterKeyBytesFor(1)),
    );
    return {
      sealedDek: Buffer.from(sealed.dek),
      sealedData: Buffer.from(sealed.data),
      keyVersion: 1,
    };
  }

  async #conf(tunnelId: string): Promise<WireGuardConf> {
    return this.#unseal(await this.#row(tunnelId));
  }

  async #row(tunnelId: string): Promise<typeof tunnels.$inferSelect> {
    const [row] = await this.database.db
      .select()
      .from(tunnels)
      .where(eq(tunnels.id, tunnelId))
      .limit(1);
    if (row === undefined) throw new Error("no such tunnel");
    return row;
  }

  async #unseal(row: typeof tunnels.$inferSelect): Promise<WireGuardConf> {
    return parseWireGuardConf(
      new TextDecoder().decode(
        await openSealed(
          { dek: row.sealedDek, data: row.sealedData },
          envKeyProvider(masterKeyBytesFor(row.keyVersion)),
        ),
      ),
    );
  }

  async #view(row: typeof tunnels.$inferSelect): Promise<TunnelView> {
    let conf: WireGuardConf | null = null;
    try {
      conf = await this.#unseal(row);
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
      health: toHealth(health?.state ?? null),
      handshakeAgeSeconds: health?.handshakeAgeSeconds ?? null,
      clusterCount: await this.#clusterCount(id),
      createdAt: createdAt.toISOString(),
    };
  }
}

// A device's state as the dashboard's four-way health. Shared by the list and
// the reachability test rather than written twice: the two must never disagree
// about what "up" means, and null — no live tunnel at all — is IDLE in both.
function toHealth(state: TunnelState | null): TunnelHealth {
  if (state === null) return "IDLE";
  if (state === "up") return "UP";
  return state === "handshaking" ? "HANDSHAKING" : "DOWN";
}

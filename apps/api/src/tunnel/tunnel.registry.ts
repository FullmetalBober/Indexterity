import { promises as dns } from "node:dns";
import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { tunnelPort } from "../config/env";
import { allowPrivateTargets, assertTargetsAllowed, type TunnelRoute } from "../engine/net-guard";
import type { WireGuardConf } from "./conf";
import { type Reachability, RemoteTunnel, type TunnelEndpoint, type TunnelHealth } from "./remote";

// The one provider in this directory, and it earns that on two of the three
// counts §5.1 names: lifecycle, and being a single instance the rest of the app
// resolves against. Everything below it — the protocol, the parser — is pure or
// per-tunnel, so none of it is injectable, for the same reason analysis/ and the
// three adapters are not.
//
// It holds the map and the lifecycle; a peering itself lives in the tunnel
// service, and what this map holds is one control connection each (D113,
// amending D111's process per tunnel).

/**
 * Thrown when there is no tunnel service configured, which is a supported state:
 * the VPN feature is off, and the dashboard says so. Distinct from a service that
 * is configured and unreachable, because the remedy is different — one is an
 * operator setting a URL, the other is a container that is not answering.
 */
export class TunnelsDisabledError extends Error {
  constructor() {
    super("no tunnel service is configured, so VPN-reached clusters are unavailable");
  }
}

// Re-exported because callers have imported them from here since #353, and where
// the types live is not their business.
export type { TunnelEndpoint, TunnelHealth };

@Injectable()
export class TunnelRegistry implements OnApplicationShutdown {
  readonly #logger = new Logger(TunnelRegistry.name);
  readonly #tunnels = new Map<string, RemoteTunnel>();

  /**
   * Whether a tunnel service is configured at all.
   *
   * Read by the routes and reported to the dashboard, so a deployment without one
   * says the feature is off instead of offering a form whose every submission
   * fails at the last step.
   */
  enabled(): boolean {
    return tunnelPort() !== undefined;
  }

  /**
   * Bring a tunnel up, or replace one already up under the same id.
   *
   * Idempotent by design: the api replays its own state after a restart, and a
   * tunnel it already holds must not become a second one. Replacing is also how
   * a rotated key or a moved endpoint lands.
   */
  async open(id: string, conf: WireGuardConf): Promise<TunnelEndpoint> {
    const onError = (error: Error) => {
      // A tunnel error is a condition of this tunnel, not of the process. It is
      // logged and the peering keeps retrying; a cluster behind a tunnel that is
      // down must read as "unreachable", not as a fault in the pipeline.
      this.#logger.warn(`tunnel ${id}: ${error.message}`);
    };
    const onState = (state: string) => this.#logger.log(`tunnel ${id} is ${state}`);

    const port = tunnelPort();
    if (port === undefined) throw new TunnelsDisabledError();

    let backend: RemoteTunnel | null = null;
    backend = await RemoteTunnel.connect({
      id,
      port,
      conf,
      // Resolved and vetted HERE, because the guard is ours: a customer-supplied
      // endpoint is an outbound dial we make. The service refuses a hostname for
      // the same reason.
      gateway: await this.#resolveGateway(conf),
      onError,
      onState,
      onClose: () => {
        // REMOVED from the map, which is the opposite of what the child-process
        // version did and is the fix for what that cost: it kept the dead entry so
        // a dial would fail fast, but `endpoint()` then kept answering, and both
        // the dial path and Test short-circuit on `endpoint() !== null` — so a
        // peering whose process had died stayed dead until the row was edited or
        // the api restarted. Pressing Test, the one thing an owner would try, did
        // nothing. Gone from the map, the next openFor() reconnects.
        //
        // Only when this is still the tunnel under that id: open() replaces by
        // building the new one first and shutting the old one down after, so an
        // old connection's close arrives when the map already holds its
        // replacement.
        if (backend !== null && this.#tunnels.get(id) === backend) this.#tunnels.delete(id);
        this.#logger.warn(`tunnel ${id} lost its connection to the tunnel service`);
      },
    });

    // The replacement is built before the old one is torn down, so a failed
    // replace leaves the tunnel that was working in place rather than none.
    const previous = this.#tunnels.get(id);
    this.#tunnels.set(id, backend);
    if (previous !== undefined) await this.#shutdown(previous);

    return backend.endpoint;
  }

  /**
   * Resolve a name inside a tunnel, on the customer's own resolver.
   *
   * Exposed so the CONNECT path can judge a hostname before storing the
   * cluster, against the same answers the dial will get. Throws when the tunnel
   * is not up, which the caller treats as "cannot check" rather than "allowed".
   */
  async resolve(id: string, host: string): Promise<readonly string[]> {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined) throw new Error("tunnel is not up");
    return tunnel.resolve(host);
  }

  /**
   * This peering's SOCKS5 endpoint, or null when there is no live connection.
   *
   * `live` as well as map membership, belt and braces: every caller treats null as
   * "open it", so a stale answer here is a dial against a listener that is not
   * there — which is exactly the failure the child-process version shipped with.
   */
  endpoint(id: string): TunnelEndpoint | null {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined || !tunnel.live) return null;
    return tunnel.endpoint;
  }

  /**
   * How a dial through this tunnel must be JUDGED — its AllowedIPs, and a
   * resolver that answers inside it. Null when the tunnel is not up.
   *
   * Handed to the engine adapters alongside the proxy, because the proxy alone
   * only says where to dial. #382 is what that cost: member discovery had the
   * proxy and not this, so it judged a replica set's private members with the
   * DIRECT guard and refused every one of them.
   */
  routeFor(id: string): TunnelRoute | null {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined || !tunnel.live) return null;
    return {
      allowedIps: tunnel.allowedIps,
      // Bound to this tunnel, so a name is answered by the customer's resolver
      // rather than ours.
      resolve: (host) => this.resolve(id, host),
    };
  }

  /**
   * Handshake health, which is a condition of its own and not "the cluster is
   * broken". A stale handshake has to be distinguishable on the dashboard and
   * in the connect preflight, and a collect for a cluster whose tunnel is down
   * must not burn its scheduled occurrence.
   */
  health(id: string): TunnelHealth | null {
    return this.#tunnels.get(id)?.health() ?? null;
  }

  /**
   * Force a handshake and report whether the gateway answered, for the
   * reachability test an owner can run from the dashboard.
   *
   * Throws when the tunnel is not up, the same contract resolve() has and for
   * the same reason: the caller has just opened it, so "there is no such live
   * tunnel" is a fault here, not a verdict about the gateway.
   */
  async probe(id: string, timeoutMs?: number): Promise<Reachability> {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined) throw new Error("tunnel is not up");
    return tunnel.probe(timeoutMs);
  }

  async close(id: string): Promise<void> {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined) return;
    this.#tunnels.delete(id);
    await this.#shutdown(tunnel);
  }

  async onApplicationShutdown(): Promise<void> {
    const tunnels = [...this.#tunnels.values()];
    this.#tunnels.clear();
    await Promise.all(tunnels.map((tunnel) => this.#shutdown(tunnel)));
  }

  async #shutdown(tunnel: RemoteTunnel): Promise<void> {
    await tunnel.close().catch(() => {});
  }

  /**
   * The gateway is an outbound dial WE make, from an address a customer typed.
   * Unvetted that is a request-forgery hole wearing the tunnel's clothes — the
   * same argument #272 makes about proxyHost — so it goes through the ordinary
   * network guard as a PUBLIC target, exactly like a connection string's host.
   *
   * Resolved per attempt rather than pinned, so a gateway on dynamic DNS
   * recovers on the next handshake instead of retrying a dead address forever.
   */
  async #resolveGateway(conf: WireGuardConf): Promise<{ address: string; port: number }> {
    const { host, port } = conf.peer.endpoint;
    await assertTargetsAllowed([host], false, { allowPrivate: allowPrivateTargets() });
    const resolved = await dns.lookup(host, { family: 4 });
    return { address: resolved.address, port };
  }
}

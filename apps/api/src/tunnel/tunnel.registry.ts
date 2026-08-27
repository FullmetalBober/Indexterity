import { promises as dns } from "node:dns";
import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { tunnelBinary, tunnelRuntime } from "../config/env";
import { allowPrivateTargets, assertTargetsAllowed } from "../engine/net-guard";
import type { TunnelBackend, TunnelEndpoint, TunnelHealth } from "./backend";
import { ChildTunnel } from "./child";
import type { WireGuardConf } from "./conf";
import { InProcessTunnel } from "./inprocess";
import type { Reachability } from "./reach";

// The one provider in this directory, and it earns that on two of the three
// counts §5.1 names: lifecycle, and being a single instance the rest of the app
// resolves against. Everything below it — the protocol, the netstack, the
// parser — is pure or per-tunnel, so none of it is injectable, for the same
// reason analysis/ and the three adapters are not.
//
// It holds the map and the lifecycle and nothing about HOW a peering is carried:
// TUNNEL_RUNTIME picks between the userspace stack in this process and the Go
// binary spawned per tunnel (D111), both of which answer backend.ts. That is why
// the switch is a switch and not a fork — the same integration suite proves each.

// Re-exported because callers have imported them from here since #353, and the
// split into backend.ts is not their business.
export type { TunnelEndpoint, TunnelHealth };

@Injectable()
export class TunnelRegistry implements OnApplicationShutdown {
  readonly #logger = new Logger(TunnelRegistry.name);
  readonly #tunnels = new Map<string, TunnelBackend>();

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

    const backend =
      tunnelRuntime() === "binary"
        ? await ChildTunnel.start({
            conf,
            // Resolved and vetted HERE, once, because the guard is ours: a
            // customer-supplied endpoint is an outbound dial we make. The binary
            // refuses a hostname for the same reason.
            gateway: await this.#resolveGateway(conf),
            binary: tunnelBinary(),
            onError,
            onState,
            onExit: (code) => {
              // Not removed from the map: `endpoint()` still answers, so a dial
              // fails fast against a dead listener rather than silently opening
              // a second peering. The next open() replaces it.
              this.#logger.warn(`tunnel ${id} process exited with ${code ?? "a signal"}`);
            },
            log: (line) => this.#logger.warn(`tunnel ${id}: ${line}`),
          })
        : await InProcessTunnel.start(conf, () => this.#resolveGateway(conf), onError, onState);

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

  endpoint(id: string): TunnelEndpoint | null {
    return this.#tunnels.get(id)?.endpoint ?? null;
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

  async #shutdown(tunnel: TunnelBackend): Promise<void> {
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

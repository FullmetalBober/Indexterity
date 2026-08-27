import { promises as dns } from "node:dns";
import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { allowPrivateTargets, assertTargetsAllowed } from "../engine/net-guard";
import type { WireGuardConf } from "./conf";
import { TunnelNetstack } from "./netstack";
import { probeReachability, type Reachability } from "./reach";
import { type SocksCredentials, SocksServer } from "./socks";
import { publicKeyFromPrivate } from "./wireguard/crypto";
import { type DeviceState, TunnelDevice } from "./wireguard/device";

// The one provider in this directory, and it earns that on two of the three
// counts §5.1 names: lifecycle, and being a single instance the rest of the app
// resolves against. Everything below it — the protocol, the netstack, the
// parser — is pure or per-tunnel, so none of it is injectable, for the same
// reason analysis/ and the three adapters are not.

export interface TunnelEndpoint {
  /** Loopback SOCKS5 the drivers dial. */
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly credentials: SocksCredentials;
}

export interface TunnelHealth {
  readonly state: DeviceState;
  readonly handshakeAgeSeconds: number | null;
}

interface LiveTunnel {
  readonly device: TunnelDevice;
  readonly netstack: TunnelNetstack;
  readonly socks: SocksServer;
}

@Injectable()
export class TunnelRegistry implements OnApplicationShutdown {
  readonly #logger = new Logger(TunnelRegistry.name);
  readonly #tunnels = new Map<string, LiveTunnel>();

  /**
   * Bring a tunnel up, or replace one already up under the same id.
   *
   * Idempotent by design: the api replays its own state after a restart, and a
   * tunnel it already holds must not become a second one. Replacing is also how
   * a rotated key or a moved endpoint lands.
   */
  async open(id: string, conf: WireGuardConf): Promise<TunnelEndpoint> {
    const device = new TunnelDevice({
      keys: {
        privateKey: conf.privateKey,
        publicKey: publicKeyFromPrivate(conf.privateKey),
        peerPublicKey: conf.peer.publicKey,
        ...(conf.peer.presharedKey === undefined ? {} : { presharedKey: conf.peer.presharedKey }),
      },
      resolveEndpoint: () => this.#resolveGateway(conf),
      ...(conf.peer.persistentKeepalive === undefined
        ? {}
        : { persistentKeepalive: conf.peer.persistentKeepalive }),
    });

    device.on("error", (error) => {
      // A tunnel error is a condition of this tunnel, not of the process. It is
      // logged and the device keeps retrying; a cluster behind a tunnel that is
      // down must read as "unreachable", not as a fault in the pipeline.
      this.#logger.warn(`tunnel ${id}: ${error.message}`);
    });
    device.on("state", (state) => this.#logger.log(`tunnel ${id} is ${state}`));

    let netstack: TunnelNetstack;
    let socks: SocksServer;
    try {
      netstack = await TunnelNetstack.create(device, conf);
      await device.start();
      socks = await SocksServer.start(netstack);
    } catch (error) {
      device.close();
      throw error;
    }

    // The replacement is built before the old one is torn down, so a failed
    // replace leaves the tunnel that was working in place rather than none.
    const previous = this.#tunnels.get(id);
    this.#tunnels.set(id, { device, netstack, socks });
    if (previous !== undefined) await this.#shutdown(previous);

    return { host: "127.0.0.1", port: socks.port, credentials: socks.credentials };
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
    return tunnel.netstack.resolve(host);
  }

  endpoint(id: string): TunnelEndpoint | null {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined) return null;
    return {
      host: "127.0.0.1",
      port: tunnel.socks.port,
      credentials: tunnel.socks.credentials,
    };
  }

  /**
   * Handshake health, which is a condition of its own and not "the cluster is
   * broken". A stale handshake has to be distinguishable on the dashboard and
   * in the connect preflight, and a collect for a cluster whose tunnel is down
   * must not burn its scheduled occurrence.
   */
  health(id: string): TunnelHealth | null {
    const tunnel = this.#tunnels.get(id);
    if (tunnel === undefined) return null;
    return {
      state: tunnel.device.state,
      handshakeAgeSeconds: tunnel.device.handshakeAgeSeconds(),
    };
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
    return probeReachability(tunnel.device, timeoutMs);
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

  async #shutdown(tunnel: LiveTunnel): Promise<void> {
    await tunnel.socks.close().catch(() => {});
    tunnel.netstack.close();
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

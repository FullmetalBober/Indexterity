import type { TunnelBackend, TunnelEndpoint, TunnelHealth } from "./backend";
import type { WireGuardConf } from "./conf";
import { TunnelNetstack } from "./netstack";
import { probeReachability, type Reachability } from "./reach";
import { SocksServer } from "./socks";
import { publicKeyFromPrivate } from "./wireguard/crypto";
import { TunnelDevice } from "./wireguard/device";

// The peering carried in this process: our WireGuard over lwIP-in-WASM, with a
// SOCKS5 front end the drivers dial.
//
// Lifted out of the registry unchanged when the Go binary arrived (D111), so the
// two implementations sit side by side and the registry holds neither. It stays
// the default until the binary has been run in anger somewhere.

export class InProcessTunnel implements TunnelBackend {
  readonly endpoint: TunnelEndpoint;
  readonly #device: TunnelDevice;
  readonly #netstack: TunnelNetstack;
  readonly #socks: SocksServer;

  private constructor(device: TunnelDevice, netstack: TunnelNetstack, socks: SocksServer) {
    this.#device = device;
    this.#netstack = netstack;
    this.#socks = socks;
    this.endpoint = { host: "127.0.0.1", port: socks.port, credentials: socks.credentials };
  }

  /**
   * `resolveGateway` is a callback rather than an address because the network
   * guard vets the gateway on every attempt — a customer-supplied endpoint is an
   * outbound dial we make — and because a gateway on dynamic DNS then recovers
   * on the next attempt instead of pinning a dead address.
   */
  static async start(
    conf: WireGuardConf,
    resolveGateway: () => Promise<{ address: string; port: number }>,
    onError: (error: Error) => void,
    onState: (state: string) => void,
  ): Promise<InProcessTunnel> {
    const device = new TunnelDevice({
      keys: {
        privateKey: conf.privateKey,
        publicKey: publicKeyFromPrivate(conf.privateKey),
        peerPublicKey: conf.peer.publicKey,
        ...(conf.peer.presharedKey === undefined ? {} : { presharedKey: conf.peer.presharedKey }),
      },
      resolveEndpoint: resolveGateway,
      ...(conf.peer.persistentKeepalive === undefined
        ? {}
        : { persistentKeepalive: conf.peer.persistentKeepalive }),
    });

    device.on("error", onError);
    device.on("state", onState);

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
    return new InProcessTunnel(device, netstack, socks);
  }

  async resolve(host: string): Promise<readonly string[]> {
    return this.#netstack.resolve(host);
  }

  health(): TunnelHealth {
    return {
      state: this.#device.state,
      handshakeAgeSeconds: this.#device.handshakeAgeSeconds(),
    };
  }

  async probe(timeoutMs?: number): Promise<Reachability> {
    return probeReachability(this.#device, timeoutMs);
  }

  async close(): Promise<void> {
    // Best effort on the socket, then the netstack — which closes the device.
    await this.#socks.close().catch(() => {});
    this.#netstack.close();
  }
}

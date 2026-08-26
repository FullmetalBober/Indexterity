import { isIP } from "node:net";
import type { WireGuardConf } from "./conf";
import { type DnsTransport, resolveThroughTunnel } from "./dns";
import { assertDialableThroughTunnel, type Cidr, parseCidr } from "./guard";
import type { TunnelDevice } from "./wireguard/device";

// A userspace TCP/IP stack bound to one tunnel, so a packet for 10.x inside it
// never touches the host's routing table.
//
// That isolation is what makes the hosted design possible at all. Two customers
// both using 10.0.0.0/8 — which is most of them — would collide in a shared
// routing table, and there is no correct answer for where 10.1.2.3 should go.
// Here each tunnel has its own stack, so the question never arises.
//
// lwIP compiled to WASM (tcpip.js) does the TCP; we do not write a TCP state
// machine, which is the part of "userspace networking" that would be reckless
// to hand-roll under production database load.
//
// tcpip is loaded through a DYNAMIC import, and it has to be. Version 0.4.0
// publishes a CommonJS bundle that is not valid JavaScript — a stray `;,this`
// their bundler emits for a class field — so `require("tcpip")` throws a
// SyntaxError at load. The ESM build is fine, and a dynamic import reaches it
// from this CommonJS package. `.swcrc` sets module.ignoreDynamic so the build
// leaves the import() alone rather than lowering it back to a require().

const DNS_PORT = 53;

// tcpip types its interface address as a literal template rather than a plain
// string, so the octets have to be numbers by the time they reach it. Building
// it here also validates the address one last time before lwIP sees it.
function toIPv4Cidr(entry: string): `${number}.${number}.${number}.${number}/${number}` {
  const [address, prefix = "32"] = entry.split("/");
  const octets = (address ?? "").split(".").map(Number);
  const [a, b, c, d] = octets;
  if (
    octets.length !== 4 ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`${entry} is not an IPv4 address`);
  }
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`${entry} has an impossible prefix length`);
  }
  return `${a}.${b}.${c}.${d}/${bits}`;
}

type Stack = Awaited<ReturnType<typeof import("tcpip").createStack>>;

export interface TunnelConnection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export class TunnelNetstack {
  #device: TunnelDevice;
  #stack: Stack;
  #allowedIps: readonly Cidr[];
  #dnsServers: readonly string[];
  #closed = false;

  private constructor(
    device: TunnelDevice,
    stack: Stack,
    allowedIps: readonly Cidr[],
    dnsServers: readonly string[],
  ) {
    this.#device = device;
    this.#stack = stack;
    this.#allowedIps = allowedIps;
    this.#dnsServers = dnsServers;
  }

  static async create(device: TunnelDevice, conf: WireGuardConf): Promise<TunnelNetstack> {
    // tcpip 0.4.0's tun takes an IPv4 CIDR and nothing else. Refused here with
    // the reason rather than left to fail as an opaque type error at runtime —
    // a v6-only peering is a legitimate config we simply cannot carry yet.
    const address = conf.addresses.find((entry) => isIP(entry.split("/")[0] ?? entry) === 4);
    if (address === undefined) {
      throw new Error(
        "this tunnel's [Interface] Address is IPv6-only, and the userspace network stack " +
          "carries IPv4 today — give the interface an IPv4 address to use it",
      );
    }

    const { createStack } = await import("tcpip");
    const stack = await createStack();
    const tun = await stack.interfaces.createTun({ ip: toIPv4Cidr(address) });

    // Outbound: lwIP emits an IP packet, the device seals it.
    void (async () => {
      for await (const packet of tun.listen()) {
        try {
          device.send(packet);
        } catch {
          // A closed or un-handshaken tunnel drops the packet; TCP above will
          // retransmit, which is exactly the behaviour a lossy link should get.
        }
      }
    })();

    // Inbound: a decrypted IP packet is something lwIP can route.
    const writer = tun.writable.getWriter();
    device.on("packet", (packet) => {
      void writer.write(packet).catch(() => {});
    });

    return new TunnelNetstack(device, stack, conf.peer.allowedIps.map(parseCidr), conf.dns);
  }

  /** DNS over the tunnel's own UDP, so the customer's resolver answers. */
  #dnsTransport: DnsTransport = async (query, server) => {
    const socket = await this.#stack.udp.open({});
    try {
      const writer = socket.writable.getWriter();
      await writer.write({ host: server, port: DNS_PORT, data: query });
      writer.releaseLock();
      for await (const datagram of socket) {
        return Buffer.from(datagram.data);
      }
      throw new Error("the resolver closed without answering");
    } finally {
      await socket.close().catch(() => {});
    }
  };

  async resolve(host: string): Promise<string[]> {
    return resolveThroughTunnel(host, this.#dnsServers, this.#dnsTransport);
  }

  /**
   * Open a TCP connection through the tunnel.
   *
   * Resolution happens first and on the far side, then EVERY address it
   * returned is judged before any of them is dialled — a permitted A record
   * must not excuse a forbidden AAAA record, which is the rule assertHostname
   * already applies outside the tunnel.
   */
  async connect(host: string, port: number): Promise<TunnelConnection> {
    if (this.#closed) throw new Error("tunnel is closed");

    const addresses = await this.resolve(host);
    if (addresses.length === 0) {
      throw new Error(`${host} resolves to nothing inside the tunnel`);
    }
    for (const address of addresses) assertDialableThroughTunnel(address, this.#allowedIps);

    let firstError: Error | null = null;
    for (const address of addresses) {
      // IPv4 only, for the same reason the interface is.
      if (isIP(address) !== 4) continue;
      try {
        const connection = await this.#stack.tcp.connect({ host: address, port });
        return connection;
      } catch (error) {
        firstError ??= error as Error;
      }
    }
    throw firstError ?? new Error(`${host} has no IPv4 address reachable through this tunnel`);
  }

  close(): void {
    this.#closed = true;
    this.#device.close();
  }
}

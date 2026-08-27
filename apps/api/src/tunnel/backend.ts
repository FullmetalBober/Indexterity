import type { Reachability } from "./reach";
import type { SocksCredentials } from "./socks";
import type { DeviceState } from "./wireguard/device";

// What one live peering can be asked, whichever implementation is carrying it.
//
// Two answer this: the userspace stack in this process (inprocess.ts) and the Go
// binary the api spawns per tunnel (child.ts, D111). The registry above holds the
// map and the lifecycle and knows nothing else about the difference, which is
// what lets TUNNEL_RUNTIME be a switch rather than a fork — and what lets the
// same integration suite prove both.

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

export interface TunnelBackend {
  /** Where the drivers dial. Fixed for the life of the peering. */
  readonly endpoint: TunnelEndpoint;

  /**
   * Resolve a name INSIDE the tunnel, on the customer's own resolver. Throws
   * when it cannot be answered, which every caller treats as "cannot check"
   * rather than as "allowed".
   */
  resolve(host: string): Promise<readonly string[]>;

  health(): TunnelHealth;

  /**
   * Force a handshake and report whether the gateway answered. See reach.ts for
   * why this is forced rather than read off the state.
   */
  probe(timeoutMs?: number): Promise<Reachability>;

  close(): Promise<void>;
}

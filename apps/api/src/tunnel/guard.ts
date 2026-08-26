import { isIP } from "node:net";
import { classifyAddress } from "../engine/net-guard";

// The in-tunnel half of the network guard.
//
// It reuses classifyAddress from engine/net-guard rather than restating the
// ranges, and that is the whole point: two classifiers are two chances to
// disagree, and the one that disagrees quietly is the one that lets a metadata
// address through. There is exactly one table of what an address IS; what
// differs between the two sides is what a category MEANS.
//
//   outside a tunnel   PRIVATE is refused unless ALLOW_PRIVATE_CLUSTER_TARGETS
//   inside a tunnel    PRIVATE is the entire point and is allowed
//   either way         FORBIDDEN is refused
//
// FORBIDDEN staying refused inside a tunnel is not caution for its own sake.
// 169.254.169.254 is never a database, and a peer whose AllowedIPs covers it is
// either misconfigured or is asking us to read our own cloud metadata for them
// — the request-forgery primitive D18 closed, re-opened through a route rather
// than through a resolver.

export class TunnelTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelTargetError";
  }
}

export interface Cidr {
  readonly address: string;
  readonly bits: number;
}

export function parseCidr(entry: string): Cidr {
  const [address, prefix] = entry.split("/");
  if (address === undefined || isIP(address) === 0) {
    throw new TunnelTargetError(`${entry} is not an address`);
  }
  const width = isIP(address) === 6 ? 128 : 32;
  const bits = prefix === undefined ? width : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) {
    throw new TunnelTargetError(`${entry} has an impossible prefix length`);
  }
  return { address, bits };
}

// Compared as bit strings rather than as numbers, so one implementation covers
// both families — a v4 shortcut plus a separate v6 path is where an IPv6 rule
// gets written once and tested never.
function toBits(address: string): string {
  if (isIP(address) === 4) {
    return address
      .split(".")
      .map((octet) => Number(octet).toString(2).padStart(8, "0"))
      .join("");
  }
  // Expand :: and any short groups before widening to 16 bits each.
  const [head, tail] = address.split("::");
  const left = head === undefined || head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const middle = new Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...middle, ...right]
    .map((group) =>
      Number.parseInt(group || "0", 16)
        .toString(2)
        .padStart(16, "0"),
    )
    .join("");
}

export function withinCidr(address: string, cidr: Cidr): boolean {
  // A v4 address is never inside a v6 prefix and vice versa; comparing their
  // bit strings would otherwise silently match on a shared prefix.
  if (isIP(address) !== isIP(cidr.address)) return false;
  if (cidr.bits === 0) return true;
  return toBits(address).slice(0, cidr.bits) === toBits(cidr.address).slice(0, cidr.bits);
}

/**
 * May this tunnel dial this address? Refuses with a sentence a person can act
 * on rather than letting the packet be dropped as a timeout — a timeout is
 * indistinguishable from a database that is merely down, and these two failures
 * want completely different responses.
 */
export function assertDialableThroughTunnel(address: string, allowedIps: readonly Cidr[]): void {
  const verdict = classifyAddress(address);
  if (verdict.category === "FORBIDDEN") {
    throw new TunnelTargetError(
      `refusing to connect to ${address} through the tunnel: ${verdict.reason} — ` +
        "never a database, whatever route reaches it",
    );
  }
  if (!allowedIps.some((cidr) => withinCidr(address, cidr))) {
    throw new TunnelTargetError(
      `refusing to connect to ${address}: outside this tunnel's AllowedIPs, so the peer did not ` +
        "agree to carry it",
    );
  }
}

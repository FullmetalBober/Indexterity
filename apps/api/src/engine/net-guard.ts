import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { workerEnv } from "../config/env";

// SSRF guard for customer-supplied connection strings. The control plane dials
// whatever an owner pastes, so without this an authenticated user can use it to
// probe the internal network: error and timing differences distinguish an open
// port from a closed one, and an unauthenticated internal database could be
// connected outright.
//
// Two tiers, because "private" and "never a database" are different problems:
//   FORBIDDEN — never dialed, not even with the escape hatch. Cloud metadata
//               (169.254.169.254) lives here; it is never a MongoDB host but is
//               the single highest-value SSRF target.
//   PRIVATE   — RFC1918, loopback and friends. Blocked for a hosted install,
//               allowed when ALLOW_PRIVATE_CLUSTER_TARGETS=true, which is the
//               normal case for self-hosted deployments whose database sits on
//               the same private network.

export type AddressCategory = "PUBLIC" | "PRIVATE" | "FORBIDDEN";

export interface AddressVerdict {
  readonly category: AddressCategory;
  readonly reason: string;
}

interface Range {
  readonly cidr: string;
  readonly category: AddressCategory;
  readonly reason: string;
}

const V4_RANGES: readonly Range[] = [
  { cidr: "0.0.0.0/8", category: "FORBIDDEN", reason: "unspecified address" },
  { cidr: "127.0.0.0/8", category: "PRIVATE", reason: "loopback" },
  { cidr: "10.0.0.0/8", category: "PRIVATE", reason: "private network (RFC1918)" },
  { cidr: "172.16.0.0/12", category: "PRIVATE", reason: "private network (RFC1918)" },
  { cidr: "192.168.0.0/16", category: "PRIVATE", reason: "private network (RFC1918)" },
  { cidr: "100.64.0.0/10", category: "PRIVATE", reason: "carrier-grade NAT" },
  { cidr: "169.254.0.0/16", category: "FORBIDDEN", reason: "link-local / cloud metadata" },
  { cidr: "192.0.0.0/24", category: "FORBIDDEN", reason: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", category: "FORBIDDEN", reason: "documentation range" },
  { cidr: "198.18.0.0/15", category: "FORBIDDEN", reason: "benchmarking range" },
  { cidr: "198.51.100.0/24", category: "FORBIDDEN", reason: "documentation range" },
  { cidr: "203.0.113.0/24", category: "FORBIDDEN", reason: "documentation range" },
  { cidr: "224.0.0.0/4", category: "FORBIDDEN", reason: "multicast" },
  { cidr: "240.0.0.0/4", category: "FORBIDDEN", reason: "reserved" },
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(ip: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const baseInt = ipv4ToInt(base ?? "");
  const bits = Number(bitsRaw);
  if (baseInt === null || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  // >>> 0 keeps the mask unsigned; JS bitwise ops are signed 32-bit.
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (baseInt & mask) >>> 0;
}

// An IPv6 address that merely wraps IPv4 (::ffff:10.0.0.1) must be judged as
// the IPv4 address it carries, or the whole guard is trivially bypassed.
function unwrapMappedV4(ip: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (match?.[1] !== undefined) return match[1];
  // ::ffff:c0a8:0001 — the hex form of the same thing.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return null;
}

function classifyV6(ip: string): AddressVerdict {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::0") {
    return { category: "FORBIDDEN", reason: "unspecified address" };
  }
  if (lower === "::1") return { category: "PRIVATE", reason: "loopback" };
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
    return { category: "PRIVATE", reason: "unique local address (RFC4193)" };
  }
  if (/^fe[89ab][0-9a-f]:/.test(lower)) {
    return { category: "FORBIDDEN", reason: "link-local" };
  }
  if (/^ff[0-9a-f]{2}:/.test(lower)) return { category: "FORBIDDEN", reason: "multicast" };
  if (/^2001:0?db8:/.test(lower)) {
    return { category: "FORBIDDEN", reason: "documentation range" };
  }
  return { category: "PUBLIC", reason: "public address" };
}

// Pure: what kind of address is this? Unit-tested exhaustively.
export function classifyAddress(ip: string): AddressVerdict {
  const version = isIP(ip);
  if (version === 6) {
    const mapped = unwrapMappedV4(ip);
    if (mapped !== null) return classifyAddress(mapped);
    return classifyV6(ip);
  }
  if (version !== 4) return { category: "FORBIDDEN", reason: "not an IP address" };
  const value = ipv4ToInt(ip);
  if (value === null) return { category: "FORBIDDEN", reason: "not an IP address" };
  for (const range of V4_RANGES) {
    if (inCidr(value, range.cidr)) return { category: range.category, reason: range.reason };
  }
  return { category: "PUBLIC", reason: "public address" };
}

export class BlockedTargetError extends Error {}

export interface TargetGuardOptions {
  // Self-hosted installs whose database is on the same private network set
  // this; hosted installs must not.
  readonly allowPrivate: boolean;
}

function assertAddress(host: string, ip: string, options: TargetGuardOptions): void {
  const verdict = classifyAddress(ip);
  if (verdict.category === "PUBLIC") return;
  if (verdict.category === "PRIVATE" && options.allowPrivate) return;
  const suffix =
    verdict.category === "PRIVATE"
      ? " — set ALLOW_PRIVATE_CLUSTER_TARGETS=true if this deployment manages databases on a private network"
      : "";
  throw new BlockedTargetError(
    `refusing to connect to ${host} (${ip}): ${verdict.reason}${suffix}`,
  );
}

// Every address a hostname resolves to must pass: one public A record does not
// excuse a private AAAA record.
async function assertHostname(host: string, options: TargetGuardOptions): Promise<void> {
  let addresses: string[];
  try {
    const resolved = await dns.lookup(host, { all: true, verbatim: true });
    addresses = resolved.map((entry) => entry.address);
  } catch {
    // Unresolvable: undialable too. Let the connection attempt fail with its
    // own clear "unreachable" message rather than a confusing security error.
    return;
  }
  for (const address of addresses) assertAddress(host, address, options);
}

// Validate every host a connection string would dial, resolving DNS first.
// SRV strings (mongodb+srv://, i.e. Atlas) are expanded: the SRV targets are
// what actually get dialed, so validating only the seed domain proves nothing.
//
// Residual risk: DNS can change between this check and the driver's own
// resolution (rebinding). Pinning would require the driver to accept resolved
// addresses; documented on the wiki's Architecture page, under Security.
export async function assertTargetsAllowed(
  hosts: readonly string[],
  isSrv: boolean,
  options: TargetGuardOptions,
): Promise<void> {
  for (const hostPort of hosts) {
    // Strip the port; keep bracketed IPv6 literals intact.
    const bracketed = /^\[([^\]]+)\]/.exec(hostPort);
    const host = bracketed?.[1] ?? hostPort.split(":")[0] ?? hostPort;
    if (host.length === 0) continue;

    if (isIP(host) !== 0) {
      assertAddress(host, host, options);
      continue;
    }
    if (isSrv) {
      let targets: string[] = [];
      try {
        const records = await dns.resolveSrv(`_mongodb._tcp.${host}`);
        targets = records.map((record) => record.name);
      } catch {
        // No SRV record — fall back to the seed host's own addresses.
      }
      if (targets.length > 0) {
        for (const target of targets) await assertHostname(target, options);
        continue;
      }
    }
    await assertHostname(host, options);
  }
}

export function allowPrivateTargets(): boolean {
  return workerEnv().ALLOW_PRIVATE_CLUSTER_TARGETS;
}

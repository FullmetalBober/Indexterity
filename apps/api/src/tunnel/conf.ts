import { isIP } from "node:net";
import { at } from "../errors/at";

// The wg0.conf a customer exports from their VPN admin, parsed into something
// the tunnel can be built from.
//
// Pure, and deliberately strict. This is a customer-supplied string that
// decides which addresses the control plane will dial, so anything it cannot
// state exactly is refused rather than defaulted: a config that quietly means
// something other than what its author read is the failure mode with the worst
// consequences here.
//
// Only the directives WireGuard itself defines are accepted. wg-quick's script
// hooks (PostUp, PreDown, ...) are refused LOUDLY rather than ignored, because
// ignoring them silently would run a config whose author expects side effects
// that never happen — and on their side of the tunnel, not ours.

interface WireGuardPeerConf {
  readonly publicKey: Buffer;
  readonly presharedKey?: Buffer | undefined;
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly allowedIps: readonly string[];
  readonly persistentKeepalive?: number | undefined;
}

export interface WireGuardConf {
  readonly privateKey: Buffer;
  readonly addresses: readonly string[];
  readonly dns: readonly string[];
  readonly mtu: number;
  readonly peer: WireGuardPeerConf;
}

export class InvalidWireGuardConfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWireGuardConfError";
  }
}

// A function declaration, not a const arrow: only the declaration form gives
// callers control-flow narrowing on `never`, and without it every guard below
// has to repeat the check it just made.
function fail(message: string): never {
  throw new InvalidWireGuardConfError(message);
}

// wg-quick runs these as shell commands when it brings an interface up. We are
// not wg-quick and never will be, so a config carrying them is a config written
// for something else.
const SCRIPT_DIRECTIVES = new Set([
  "postup",
  "predown",
  "postdown",
  "preup",
  "table",
  "saveconfig",
]);

const DEFAULT_MTU = 1420;

function parseKey(value: string, what: string): Buffer {
  const raw = Buffer.from(value, "base64");
  // base64 is permissive — it decodes almost anything to *something* — so the
  // length is the only real check available.
  if (raw.length !== 32) fail(`${what} is not a 32-byte WireGuard key`);
  return raw;
}

function parseCidrList(value: string, what: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) fail(`${what} is empty`);
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    if (address === undefined || isIP(address) === 0)
      fail(`${what} entry ${entry} is not an address`);
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const max = isIP(address) === 6 ? 128 : 32;
      if (!Number.isInteger(bits) || bits < 0 || bits > max) {
        fail(`${what} entry ${entry} has an impossible prefix length`);
      }
    }
  }
  return entries;
}

// host:port, where host may be a name, an IPv4 literal, or a bracketed IPv6
// literal. Kept as written rather than resolved: this is the one outbound dial
// the tunnel itself makes, and the network guard vets it as a public target at
// dial time, on the addresses it resolves then.
function parseEndpoint(value: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value.trim());
  const plain = /^([^:]+):(\d+)$/.exec(value.trim());
  const match = bracketed ?? plain;
  const host = match?.[1];
  const portText = match?.[2];
  if (host === undefined || portText === undefined) fail(`Endpoint ${value} is not host:port`);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail(`Endpoint port ${portText} is not a port`);
  return { host, port };
}

export function parseWireGuardConf(text: string): WireGuardConf {
  let section: "interface" | "peer" | null = null;
  const interfaceFields = new Map<string, string>();
  const peers: Map<string, string>[] = [];

  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    // A comment can also trail a value, which is why this strips rather than
    // only skipping whole-line comments.
    const line = raw.replace(/[#;].*$/, "").trim();
    if (line.length === 0) continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      const name = header[1].trim().toLowerCase();
      if (name === "interface") {
        if (section !== null || interfaceFields.size > 0) fail("more than one [Interface] section");
        section = "interface";
      } else if (name === "peer") {
        section = "peer";
        peers.push(new Map());
      } else {
        fail(`unknown section [${header[1]}] on line ${index + 1}`);
      }
      continue;
    }

    const [keyPart, ...valueParts] = line.split("=");
    if (keyPart === undefined || valueParts.length === 0) {
      fail(`line ${index + 1} is not a key = value pair`);
    }
    const directive = keyPart.trim();
    const key = directive.toLowerCase();
    // Rejoined, because a base64 key legitimately contains '='.
    const value = valueParts.join("=").trim();

    if (SCRIPT_DIRECTIVES.has(key)) {
      fail(
        `${directive} is a wg-quick directive that runs commands, and this is not wg-quick — ` +
          "remove it, and arrange routing on your own side of the tunnel",
      );
    }
    if (section === null) fail(`line ${index + 1} is outside any section`);
    if (section === "interface") interfaceFields.set(key, value);
    else peers[peers.length - 1]?.set(key, value);
  }

  const privateKeyRaw = interfaceFields.get("privatekey");
  if (privateKeyRaw === undefined) fail("[Interface] has no PrivateKey");
  const privateKey = parseKey(privateKeyRaw, "[Interface] PrivateKey");

  const addressRaw = interfaceFields.get("address");
  if (addressRaw === undefined) fail("[Interface] has no Address");
  const addresses = parseCidrList(addressRaw, "[Interface] Address");

  const dnsRaw = interfaceFields.get("dns");
  const dns =
    dnsRaw === undefined
      ? []
      : parseCidrList(dnsRaw, "[Interface] DNS").map((e) => e.split("/")[0] ?? e);

  const mtuRaw = interfaceFields.get("mtu");
  const mtu = mtuRaw === undefined ? DEFAULT_MTU : Number(mtuRaw);
  // The floor is IPv6's minimum link MTU; below it a legitimate packet cannot
  // be carried and the tunnel would look flaky rather than misconfigured.
  if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 1500)
    fail(`[Interface] MTU ${mtuRaw} is out of range`);

  if (peers.length === 0) fail("the config has no [Peer] section");
  // One gateway per tunnel. Multiple peers is legal WireGuard and means routing
  // by AllowedIPs between them — a decision that belongs to the customer's own
  // network, not to a connection we hold on their behalf.
  if (peers.length > 1) {
    fail(
      `the config has ${peers.length} [Peer] sections; a cluster tunnel reaches exactly one gateway`,
    );
  }
  const peerFields = at(peers);

  const peerKeyRaw = peerFields.get("publickey");
  if (peerKeyRaw === undefined) fail("[Peer] has no PublicKey");
  const publicKey = parseKey(peerKeyRaw, "[Peer] PublicKey");

  const endpointRaw = peerFields.get("endpoint");
  // Without an Endpoint the peer is expected to dial US, and nothing about a
  // hosted control plane can accept an inbound connection from a customer VPN.
  if (endpointRaw === undefined) {
    fail("[Peer] has no Endpoint — Indexterity dials out, so the gateway's address is required");
  }
  const endpoint = parseEndpoint(endpointRaw);

  const allowedRaw = peerFields.get("allowedips");
  if (allowedRaw === undefined) fail("[Peer] has no AllowedIPs");
  const allowedIps = parseCidrList(allowedRaw, "[Peer] AllowedIPs");

  const presharedRaw = peerFields.get("presharedkey");
  const presharedKey =
    presharedRaw === undefined ? undefined : parseKey(presharedRaw, "[Peer] PresharedKey");

  const keepaliveRaw = peerFields.get("persistentkeepalive");
  let persistentKeepalive: number | undefined;
  if (keepaliveRaw !== undefined && keepaliveRaw !== "off") {
    persistentKeepalive = Number(keepaliveRaw);
    if (
      !Number.isInteger(persistentKeepalive) ||
      persistentKeepalive < 1 ||
      persistentKeepalive > 65535
    ) {
      fail(`[Peer] PersistentKeepalive ${keepaliveRaw} is not a number of seconds`);
    }
  }

  return {
    privateKey,
    addresses,
    dns,
    mtu,
    peer: { publicKey, presharedKey, endpoint, allowedIps, persistentKeepalive },
  };
}

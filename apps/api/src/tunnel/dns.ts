import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

// DNS, encoded and decoded here rather than taken from a library, because the
// query has to travel over the TUNNEL's UDP rather than the host's resolver.
//
// That is not a detail. A private replica set's member names mean something
// only on the customer's side — `mongodb://mongo-0.internal:27017` resolves to
// nothing from our network, and worse, could resolve to something ELSE that we
// would then dial. Every name a tunnelled connection string carries has to be
// answered by the customer's own DNS, reached through their own tunnel.
//
// The transport is injected rather than imported, so the encoding is testable
// without a netstack and the netstack is testable without a real resolver.

const QUERY_TIMEOUT_MS = 5_000;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;
// Two high bits set marks a pointer rather than a length, RFC 1035 §4.1.4.
const POINTER_MASK = 0xc0;

export class DnsError extends Error {}

export function encodeQuery(name: string, type: number, id: number): Buffer {
  const labels = name.replace(/\.$/, "").split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63)
      throw new DnsError(`${name} has an unusable label`);
  }
  const question = Buffer.concat([
    ...labels.map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")]),
    ),
    Buffer.from([0]),
  ]);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  // Recursion desired: the resolver inside the tunnel is expected to do the
  // work, exactly as it would for any host on that network.
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, question, tail]);
}

// Names are length-prefixed label sequences that may END in a pointer back into
// the message, so decoding one means following those — and refusing to follow
// them forever, since a message that points at itself is a hang otherwise.
function readName(message: Buffer, start: number): { end: number } {
  let offset = start;
  let jumped = false;
  let end = start;
  let guard = 0;

  while (offset < message.length) {
    if (guard++ > 128) throw new DnsError("compression pointer loop");
    const length = message.readUInt8(offset);
    if (length === 0) {
      if (!jumped) end = offset + 1;
      return { end };
    }
    if ((length & POINTER_MASK) === POINTER_MASK) {
      if (offset + 1 >= message.length) throw new DnsError("truncated compression pointer");
      if (!jumped) end = offset + 2;
      offset = ((length & 0x3f) << 8) | message.readUInt8(offset + 1);
      jumped = true;
      continue;
    }
    offset += length + 1;
  }
  throw new DnsError("name runs past the end of the message");
}

export function decodeAnswers(message: Buffer, expectedId: number): string[] {
  if (message.length < 12) throw new DnsError("response is shorter than a header");
  if (message.readUInt16BE(0) !== expectedId)
    throw new DnsError("response id does not match the query");

  const flags = message.readUInt16BE(2);
  const rcode = flags & 0x0f;
  // NXDOMAIN is a real answer — the name does not exist inside the tunnel —
  // and reads as an empty result rather than a failure, so the caller can say
  // "unreachable" instead of "DNS broke".
  if (rcode === 3) return [];
  if (rcode !== 0) throw new DnsError(`resolver answered with rcode ${rcode}`);

  const questions = message.readUInt16BE(4);
  const answers = message.readUInt16BE(6);

  let offset = 12;
  for (let index = 0; index < questions; index += 1) {
    offset = readName(message, offset).end + 4;
  }

  const addresses: string[] = [];
  for (let index = 0; index < answers; index += 1) {
    if (offset + 10 > message.length) throw new DnsError("answer runs past the end of the message");
    offset = readName(message, offset).end;
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 8);
    const data = offset + 10;
    if (data + length > message.length) throw new DnsError("record data runs past the end");

    if (type === TYPE_A && length === 4) {
      addresses.push([...message.subarray(data, data + 4)].join("."));
    } else if (type === TYPE_AAAA && length === 16) {
      const parts: string[] = [];
      for (let byte = 0; byte < 16; byte += 2) {
        parts.push(message.readUInt16BE(data + byte).toString(16));
      }
      addresses.push(parts.join(":"));
    }
    // Anything else — CNAME, SOA — is skipped rather than followed: the
    // resolver was asked to recurse, so an address should already be here.
    offset = data + length;
  }
  return addresses;
}

/** Send one query and wait for one reply, or reject. */
export type DnsTransport = (query: Buffer, server: string) => Promise<Buffer>;

/**
 * Resolve a name through the tunnel. Both families are asked for, because a
 * connection string naming a host with only an AAAA record is not an error —
 * and every address that comes back is judged by the caller before any dial.
 */
export async function resolveThroughTunnel(
  name: string,
  servers: readonly string[],
  transport: DnsTransport,
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<string[]> {
  if (isIP(name) !== 0) return [name];
  if (servers.length === 0) {
    throw new DnsError(
      `cannot resolve ${name}: the tunnel's config carries no DNS, and this name means nothing on our side`,
    );
  }

  const errors: string[] = [];
  for (const server of servers) {
    const found: string[] = [];
    for (const type of [TYPE_A, TYPE_AAAA]) {
      const id = randomBytes(2).readUInt16BE(0);
      try {
        const reply = await withTimeout(transport(encodeQuery(name, type, id), server), timeoutMs);
        found.push(...decodeAnswers(reply, id));
      } catch (error) {
        errors.push(`${server}: ${(error as Error).message}`);
      }
    }
    // First server that answers with anything wins; the rest are fallbacks for
    // a resolver that is down, not a second opinion on an answer we have.
    if (found.length > 0) return found;
  }
  if (errors.length > 0)
    throw new DnsError(`resolving ${name} in the tunnel failed — ${errors.join("; ")}`);
  return [];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DnsError(`no answer in ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

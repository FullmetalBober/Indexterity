import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

// The primitives WireGuard is built from, and nothing above them: this file
// knows about BLAKE2s and X25519, not about handshakes or peers.
//
// Split across two providers on purpose, and the split is not arbitrary.
// node:crypto (OpenSSL) does the bulk work — X25519 and ChaCha20-Poly1305 run
// on every packet, and an assembly implementation is worth having there. It
// cannot do the rest: WireGuard's MAC is BLAKE2s KEYED with a 16-byte digest,
// and node refuses both (`createHash` takes no key, and outputLength 16 raises
// "not XOF or invalid length"). @noble/hashes supplies those, and it is the
// same author and family as the @noble/ciphers D8 already chose, rather than a
// new trust decision.
//
// Nothing here is hand-rolled cryptography. It is protocol plumbing over two
// audited implementations, which is the whole reason the pure-node route is
// defensible at all.

export const KEY_LENGTH = 32;
export const MAC_LENGTH = 16;
export const TAG_LENGTH = 16;
export const TIMESTAMP_LENGTH = 12;

// Fixed strings from the WireGuard whitepaper, §5.4. These are hashed into the
// very first chaining key, so a byte wrong here fails every handshake with no
// diagnostic beyond silence.
export const CONSTRUCTION = "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s";
export const IDENTIFIER = "WireGuard v1 zx2c4 Jason@zx2c4.com";
export const LABEL_MAC1 = "mac1----";
export const LABEL_COOKIE = "cookie--";

export function hash(...parts: readonly Uint8Array[]): Buffer {
  const total = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.from(blake2s(total));
}

// BLAKE2s keyed, 16 bytes out — mac1 and mac2, and the one thing OpenSSL will
// not do for us.
export function mac(key: Uint8Array, ...parts: readonly Uint8Array[]): Buffer {
  const total = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.from(blake2s(total, { key, dkLen: MAC_LENGTH }));
}

function hmacBlake2s(key: Uint8Array, data: Uint8Array): Buffer {
  return Buffer.from(hmac(blake2s, key, data));
}

// HKDF over HMAC-BLAKE2s, whitepaper §5.4. Returns `count` 32-byte keys, each
// derived from the last — so asking for two and using only the first is not the
// same as asking for one, and the call sites say which they mean.
export function kdf(count: 1, key: Uint8Array, input: Uint8Array): [Buffer];
export function kdf(count: 2, key: Uint8Array, input: Uint8Array): [Buffer, Buffer];
export function kdf(count: 3, key: Uint8Array, input: Uint8Array): [Buffer, Buffer, Buffer];
export function kdf(count: 1 | 2 | 3, key: Uint8Array, input: Uint8Array): Buffer[] {
  const tau0 = hmacBlake2s(key, input);
  const out: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  for (let index = 1; index <= count; index += 1) {
    previous = hmacBlake2s(tau0, Buffer.concat([previous, Buffer.from([index])]));
    out.push(previous);
  }
  return out;
}

// X25519 keys travel as 32 raw bytes everywhere in WireGuard — in a wg0.conf,
// on the wire, in the UAPI. node's key objects want DER, so these two prefixes
// wrap and unwrap it. They are the fixed SPKI/PKCS8 headers for the X25519
// algorithm identifier (1.3.101.110) and nothing about them varies per key.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export function importPublicKey(raw: Uint8Array) {
  if (raw.length !== KEY_LENGTH) throw new Error(`public key is ${raw.length} bytes, want 32`);
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

export function importPrivateKey(raw: Uint8Array) {
  if (raw.length !== KEY_LENGTH) throw new Error(`private key is ${raw.length} bytes, want 32`);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "pkcs8",
  });
}

export function generateKeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(PKCS8_PREFIX.length),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length),
  };
}

export function publicKeyFromPrivate(rawPrivate: Uint8Array): Buffer {
  // Through PEM because createPublicKey's typings accept a private key that way
  // and not as raw pkcs8 DER. Node derives the public half either way, and this
  // runs once per tunnel rather than once per packet, so the round trip is free.
  const pem = importPrivateKey(rawPrivate).export({ format: "pem", type: "pkcs8" });
  const publicKey = createPublicKey({ key: pem, format: "pem" });
  return publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

export function dh(rawPrivate: Uint8Array, rawPublic: Uint8Array): Buffer {
  return diffieHellman({
    privateKey: importPrivateKey(rawPrivate),
    publicKey: importPublicKey(rawPublic),
  });
}

// A shared secret of all zeros means the peer sent a low-order point, and the
// whitepaper requires rejecting it rather than continuing with a secret both
// sides could predict.
export function isAllZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

// WireGuard's nonce is 4 zero bytes then a little-endian 64-bit counter — NOT
// the big-endian a reader used to network byte order expects, and one of the
// few places this protocol reverses the usual convention.
export function nonce(counter: bigint): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(counter, 4);
  return out;
}

export function aeadEncrypt(
  key: Uint8Array,
  counter: bigint,
  plaintext: Uint8Array,
  associated: Uint8Array,
): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce(counter), {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(associated), { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

export function aeadDecrypt(
  key: Uint8Array,
  counter: bigint,
  ciphertext: Uint8Array,
  associated: Uint8Array,
): Buffer {
  if (ciphertext.length < TAG_LENGTH) throw new Error("ciphertext is shorter than its tag");
  const body = Buffer.from(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH));
  const tag = Buffer.from(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce(counter), {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(associated), { plaintextLength: body.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// TAI64N, which is what WireGuard stamps a handshake with rather than a unix
// timestamp: 2^62 plus the unix seconds, big-endian, then nanoseconds. The
// responder keeps the greatest one it has seen per peer and rejects anything
// not strictly greater, which is what makes a captured initiation unreplayable.
export function tai64n(nowMs: number = Date.now()): Buffer {
  const out = Buffer.alloc(TIMESTAMP_LENGTH);
  const seconds = BigInt(Math.floor(nowMs / 1000));
  out.writeBigUInt64BE(0x400000000000000an + seconds, 0);
  out.writeUInt32BE(Math.floor((nowMs % 1000) * 1e6), 8);
  return out;
}

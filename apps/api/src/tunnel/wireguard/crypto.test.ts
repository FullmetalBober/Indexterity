import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  dh,
  equal,
  generateKeyPair,
  hash,
  isAllZero,
  kdf,
  mac,
  nonce,
  publicKeyFromPrivate,
  tai64n,
} from "./crypto";

// Published vectors, not round trips. A round trip proves this file agrees with
// itself, which is exactly the failure mode that matters here: an X25519 key
// wrapped in the wrong DER header still agrees with its own unwrapping, and
// every handshake against a real peer fails with nothing to read but silence.

// RFC 7748 §6.1 — the canonical X25519 exchange. Passing this proves the
// SPKI/PKCS8 wrapping, the public-key derivation and the agreement at once.
const RFC7748 = {
  alicePrivate: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  alicePublic: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  bobPrivate: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  bobPublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
};

const bytes = (hex: string) => Buffer.from(hex, "hex");

describe("X25519 against RFC 7748", () => {
  it("derives Alice's public key from her private key", () => {
    expect(publicKeyFromPrivate(bytes(RFC7748.alicePrivate)).toString("hex")).toBe(
      RFC7748.alicePublic,
    );
  });

  it("derives Bob's public key from his private key", () => {
    expect(publicKeyFromPrivate(bytes(RFC7748.bobPrivate)).toString("hex")).toBe(RFC7748.bobPublic);
  });

  it("agrees on the shared secret from either side", () => {
    expect(dh(bytes(RFC7748.alicePrivate), bytes(RFC7748.bobPublic)).toString("hex")).toBe(
      RFC7748.shared,
    );
    expect(dh(bytes(RFC7748.bobPrivate), bytes(RFC7748.alicePublic)).toString("hex")).toBe(
      RFC7748.shared,
    );
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => publicKeyFromPrivate(Buffer.alloc(31))).toThrow(/31 bytes/);
  });
});

// RFC 7693 appendix B. WireGuard hashes with unkeyed BLAKE2s-256 throughout,
// so this is the digest every chaining key is built from.
describe("BLAKE2s against RFC 7693", () => {
  it("hashes abc to the published digest", () => {
    expect(hash(Buffer.from("abc")).toString("hex")).toBe(
      "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982",
    );
  });

  it("produces a 16-byte keyed digest for mac1", () => {
    // The size is the point: node's own BLAKE2s refuses both a key and a
    // 16-byte length, which is why this comes from @noble/hashes.
    expect(mac(hash(Buffer.from("mac1----")), Buffer.from("payload"))).toHaveLength(16);
  });

  it("keys the mac — a different key gives a different tag", () => {
    const message = Buffer.from("payload");
    expect(mac(Buffer.alloc(32, 1), message).equals(mac(Buffer.alloc(32, 2), message))).toBe(false);
  });
});

describe("kdf", () => {
  it("is deterministic", () => {
    const first = kdf(3, Buffer.alloc(32, 7), Buffer.from("input"));
    const second = kdf(3, Buffer.alloc(32, 7), Buffer.from("input"));
    expect(first.map((k) => k.toString("hex"))).toEqual(second.map((k) => k.toString("hex")));
  });

  it("returns distinct keys, each 32 bytes", () => {
    const keys = kdf(3, Buffer.alloc(32, 7), Buffer.from("input"));
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(key).toHaveLength(32);
    expect(new Set(keys.map((k) => k.toString("hex"))).size).toBe(3);
  });

  // Asking for two and using the first is NOT asking for one: each output is
  // derived from the one before it. Call sites depend on that, so it is stated.
  it("chains, so a prefix of kdf(3) equals kdf(1) and kdf(2)", () => {
    const hex = (keys: Buffer[], index: number) => keys[index]?.toString("hex");
    const one = kdf(1, Buffer.alloc(32, 9), Buffer.from("x"));
    const two = kdf(2, Buffer.alloc(32, 9), Buffer.from("x"));
    const three = kdf(3, Buffer.alloc(32, 9), Buffer.from("x"));
    expect(hex(one, 0)).toBe(hex(two, 0));
    expect(hex(one, 0)).toBe(hex(three, 0));
    expect(hex(two, 1)).toBe(hex(three, 1));
  });
});

describe("nonce", () => {
  // Little-endian, which is where a reader used to network byte order gets it
  // wrong and every transport packet then fails to authenticate.
  it("puts the counter little-endian in the last 8 bytes", () => {
    expect(nonce(0n).toString("hex")).toBe("000000000000000000000000");
    expect(nonce(1n).toString("hex")).toBe("000000000100000000000000");
    expect(nonce(258n).toString("hex")).toBe("000000000201000000000000");
  });
});

describe("aead", () => {
  const key = Buffer.alloc(32, 3);
  const associated = hash(Buffer.from("header"));

  it("round trips", () => {
    const sealed = aeadEncrypt(key, 5n, Buffer.from("hello wireguard"), associated);
    expect(aeadDecrypt(key, 5n, sealed, associated).toString()).toBe("hello wireguard");
  });

  it("appends a 16-byte tag", () => {
    expect(aeadEncrypt(key, 0n, Buffer.alloc(32), associated)).toHaveLength(48);
  });

  it("rejects a wrong counter", () => {
    const sealed = aeadEncrypt(key, 5n, Buffer.from("payload"), associated);
    expect(() => aeadDecrypt(key, 6n, sealed, associated)).toThrow();
  });

  it("rejects wrong associated data", () => {
    const sealed = aeadEncrypt(key, 5n, Buffer.from("payload"), associated);
    expect(() => aeadDecrypt(key, 5n, sealed, hash(Buffer.from("other")))).toThrow();
  });

  it("rejects a flipped bit", () => {
    const sealed = aeadEncrypt(key, 5n, Buffer.from("payload"), associated);
    sealed.writeUInt8(sealed.readUInt8(0) ^ 0x01, 0);
    expect(() => aeadDecrypt(key, 5n, sealed, associated)).toThrow();
  });

  it("encrypts an empty plaintext to just a tag, which the handshake relies on", () => {
    const sealed = aeadEncrypt(key, 0n, Buffer.alloc(0), associated);
    expect(sealed).toHaveLength(16);
    expect(aeadDecrypt(key, 0n, sealed, associated)).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("spots an all-zero shared secret, which means a low-order point", () => {
    expect(isAllZero(Buffer.alloc(32))).toBe(true);
    expect(isAllZero(Buffer.alloc(32, 1))).toBe(false);
  });

  it("compares equal-length buffers without throwing on a mismatch in length", () => {
    expect(equal(Buffer.from("ab"), Buffer.from("ab"))).toBe(true);
    expect(equal(Buffer.from("ab"), Buffer.from("ac"))).toBe(false);
    expect(equal(Buffer.from("ab"), Buffer.from("abc"))).toBe(false);
  });

  it("generates a key pair whose public half derives from its private half", () => {
    const pair = generateKeyPair();
    expect(pair.privateKey).toHaveLength(32);
    expect(publicKeyFromPrivate(pair.privateKey).equals(pair.publicKey)).toBe(true);
  });

  it("stamps TAI64N as 2^62 + unix seconds, then nanoseconds", () => {
    const stamp = tai64n(1_700_000_000_123);
    expect(stamp).toHaveLength(12);
    expect(stamp.readBigUInt64BE(0)).toBe(0x400000000000000an + 1_700_000_000n);
    expect(stamp.readUInt32BE(8)).toBe(123_000_000);
  });

  it("increases, so a replayed initiation is rejected by the peer", () => {
    expect(tai64n(1_700_000_001_000).compare(tai64n(1_700_000_000_000))).toBe(1);
  });
});

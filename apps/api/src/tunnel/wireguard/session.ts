import { aeadDecrypt, aeadEncrypt } from "./crypto";
import { MESSAGE_TRANSPORT, TRANSPORT_HEADER_LENGTH, type TransportKeys } from "./handshake";

// A live session: the two keys a completed handshake produced, plus the counter
// discipline that keeps them safe to use.
//
// The counter is the whole security argument for the data phase. ChaCha20-
// Poly1305 is catastrophic under nonce reuse — two packets under one nonce
// leak the XOR of their plaintexts and forge the authenticator — so the send
// counter only ever increases, and the session is retired well before it could
// wrap. On receive, a counter already seen is refused, which is what stops a
// captured packet from being replayed back at us.

// Whitepaper §6.1. Rekey long before the counter is anywhere near 2^64: these
// are the reference implementation's numbers, not ours to tune.
export const REJECT_AFTER_MESSAGES = 2n ** 64n - 2n ** 13n - 1n;
export const REKEY_AFTER_MESSAGES = 2n ** 60n;
export const REKEY_AFTER_TIME_MS = 120_000;
export const REJECT_AFTER_TIME_MS = 180_000;

const REPLAY_WINDOW_BITS = 2048;

export class ReplayWindow {
  #greatest = -1n;
  #seen = new Set<bigint>();

  // Sliding window: anything newer than everything seen is accepted and becomes
  // the new high-water mark; anything inside the window is accepted once;
  // anything older than the window is refused outright, because we can no
  // longer prove it is not a replay and "cannot tell" must not read as "fine".
  accept(counter: bigint): boolean {
    if (counter >= REJECT_AFTER_MESSAGES) return false;
    if (counter > this.#greatest) {
      this.#greatest = counter;
      this.#seen.add(counter);
      this.#prune();
      return true;
    }
    if (this.#greatest - counter >= BigInt(REPLAY_WINDOW_BITS)) return false;
    if (this.#seen.has(counter)) return false;
    this.#seen.add(counter);
    return true;
  }

  #prune(): void {
    if (this.#seen.size <= REPLAY_WINDOW_BITS * 2) return;
    const floor = this.#greatest - BigInt(REPLAY_WINDOW_BITS);
    for (const value of this.#seen) {
      if (value < floor) this.#seen.delete(value);
    }
  }
}

export class Session {
  readonly localIndex: number;
  readonly remoteIndex: number;
  readonly establishedAt: number;

  #sendKey: Buffer;
  #receiveKey: Buffer;
  #sendCounter = 0n;
  #replay = new ReplayWindow();

  constructor(keys: TransportKeys, now: number = Date.now()) {
    this.#sendKey = keys.sendKey;
    this.#receiveKey = keys.receiveKey;
    this.localIndex = keys.localIndex;
    this.remoteIndex = keys.remoteIndex;
    this.establishedAt = now;
  }

  get sendCounter(): bigint {
    return this.#sendCounter;
  }

  // A session past either limit must not be used. Both are checked rather than
  // just the counter, because an idle tunnel ages out on time while a busy one
  // ages out on volume, and only one of the two is visible from each.
  expired(now: number = Date.now()): boolean {
    return (
      now - this.establishedAt >= REJECT_AFTER_TIME_MS || this.#sendCounter >= REJECT_AFTER_MESSAGES
    );
  }

  // Due for replacement, but still usable — the initiator starts a new
  // handshake here and keeps sending on this session until it completes, so a
  // rekey costs no dropped packets.
  needsRekey(now: number = Date.now()): boolean {
    return (
      now - this.establishedAt >= REKEY_AFTER_TIME_MS || this.#sendCounter >= REKEY_AFTER_MESSAGES
    );
  }

  // Padding to a 16-byte boundary hides the exact length of what is inside,
  // which for a database session is a meaningful signal — query and response
  // sizes are a fingerprint. The receiver recovers the true length from the IP
  // header, so the padding costs nothing but bytes.
  encapsulate(packet: Uint8Array): Buffer {
    if (this.#sendCounter >= REJECT_AFTER_MESSAGES) {
      throw new Error("session has sent too many messages and must be rekeyed");
    }
    const padded = Buffer.alloc(Math.ceil(packet.length / 16) * 16);
    Buffer.from(packet).copy(padded);

    const counter = this.#sendCounter;
    this.#sendCounter += 1n;

    const header = Buffer.alloc(TRANSPORT_HEADER_LENGTH);
    header.writeUInt8(MESSAGE_TRANSPORT, 0);
    header.writeUInt32LE(this.remoteIndex, 4);
    header.writeBigUInt64LE(counter, 8);

    // Associated data is empty — the header is not authenticated, and it does
    // not need to be: the counter is the nonce, so changing it in flight only
    // makes the tag fail, and the index only selects which key to try.
    return Buffer.concat([header, aeadEncrypt(this.#sendKey, counter, padded, Buffer.alloc(0))]);
  }

  decapsulate(datagram: Buffer): Buffer {
    if (datagram.length < TRANSPORT_HEADER_LENGTH) throw new Error("transport packet is truncated");
    const counter = datagram.readBigUInt64LE(8);
    if (!this.#replay.accept(counter)) {
      throw new Error(`transport counter ${counter} is a replay or outside the window`);
    }
    return aeadDecrypt(
      this.#receiveKey,
      counter,
      datagram.subarray(TRANSPORT_HEADER_LENGTH),
      Buffer.alloc(0),
    );
  }
}

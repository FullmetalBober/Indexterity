import { randomBytes } from "node:crypto";
import {
  aeadDecrypt,
  aeadEncrypt,
  CONSTRUCTION,
  dh,
  equal,
  generateKeyPair,
  hash,
  IDENTIFIER,
  isAllZero,
  kdf,
  LABEL_MAC1,
  mac,
  tai64n,
} from "./crypto";

// Noise_IKpsk2, the initiator half only.
//
// Only the initiator half, because that is the only side we are ever on: the
// customer's gateway has the public endpoint and we dial out to it. A responder
// would need a cookie mechanism under load and a per-peer timestamp ledger to
// refuse replays, and neither is reachable from where we sit — so writing them
// would be writing code no path can exercise.
//
// Everything is length-prefixed by the spec rather than negotiated, so the
// offsets below are constants, and every one is asserted against the message
// sizes the whitepaper fixes (148 and 92). A byte out of place here does not
// fail loudly; it fails as a peer that never answers.

export const MESSAGE_INITIATION = 1;
export const MESSAGE_RESPONSE = 2;
export const MESSAGE_COOKIE_REPLY = 3;
export const MESSAGE_TRANSPORT = 4;

export const INITIATION_LENGTH = 148;
export const RESPONSE_LENGTH = 92;
export const TRANSPORT_HEADER_LENGTH = 16;

// Offsets into a handshake initiation, in the order the wire carries them.
const INIT_SENDER = 4;
const INIT_EPHEMERAL = 8;
const INIT_STATIC = 40;
const INIT_TIMESTAMP = 88;
const INIT_MAC1 = 116;
// mac2 occupies 132..148 and stays zero — see createInitiation.

// ...and into a handshake response.
const RESP_SENDER = 4;
const RESP_RECEIVER = 8;
const RESP_EPHEMERAL = 12;
const RESP_EMPTY = 44;
const RESP_MAC1 = 60;

const ZERO_PSK = Buffer.alloc(32);

export interface StaticKeys {
  /** Ours — the [Interface] PrivateKey from the customer's wg0.conf. */
  readonly privateKey: Buffer;
  readonly publicKey: Buffer;
  /** Theirs — the [Peer] PublicKey. */
  readonly peerPublicKey: Buffer;
  /** [Peer] PresharedKey, if the config carried one. */
  readonly presharedKey?: Buffer;
}

export interface HandshakeState {
  readonly senderIndex: number;
  readonly chainingKey: Buffer;
  readonly hash: Buffer;
  readonly ephemeralPrivate: Buffer;
  readonly keys: StaticKeys;
}

export interface TransportKeys {
  readonly sendKey: Buffer;
  readonly receiveKey: Buffer;
  readonly localIndex: number;
  readonly remoteIndex: number;
}

// mac1 proves the sender knows the recipient's public key. A peer under load
// drops anything whose mac1 is wrong before spending a DH on it, so getting
// this wrong looks exactly like the peer being unreachable.
function mac1Key(peerPublicKey: Uint8Array): Buffer {
  return hash(Buffer.from(LABEL_MAC1, "utf8"), peerPublicKey);
}

export function createInitiation(keys: StaticKeys): {
  message: Buffer;
  state: HandshakeState;
} {
  const message = Buffer.alloc(INITIATION_LENGTH);
  message.writeUInt8(MESSAGE_INITIATION, 0);
  // Bytes 1..3 stay zero: reserved, and a responder checks them.

  // Our index for this session. The peer echoes it back as `receiver` on every
  // transport packet, which is how a datagram arriving on a shared socket is
  // matched to the tunnel it belongs to.
  const senderIndex = randomBytes(4).readUInt32LE(0);
  message.writeUInt32LE(senderIndex, INIT_SENDER);

  let chainingKey = hash(Buffer.from(CONSTRUCTION, "utf8"));
  let h = hash(chainingKey, Buffer.from(IDENTIFIER, "utf8"));
  h = hash(h, keys.peerPublicKey);

  const ephemeral = generateKeyPair();
  [chainingKey] = kdf(1, chainingKey, ephemeral.publicKey);
  ephemeral.publicKey.copy(message, INIT_EPHEMERAL);
  h = hash(h, ephemeral.publicKey);

  // Our static public key, encrypted under a key only the intended peer can
  // derive — this is what makes the initiator's identity hidden from anyone
  // who is not holding the responder's private key.
  const ephemeralShared = dh(ephemeral.privateKey, keys.peerPublicKey);
  if (isAllZero(ephemeralShared)) throw new Error("peer public key is a low-order point");
  const [chain1, staticKey] = kdf(2, chainingKey, ephemeralShared);
  chainingKey = chain1;
  const encryptedStatic = aeadEncrypt(staticKey, 0n, keys.publicKey, h);
  encryptedStatic.copy(message, INIT_STATIC);
  h = hash(h, encryptedStatic);

  const staticShared = dh(keys.privateKey, keys.peerPublicKey);
  if (isAllZero(staticShared)) throw new Error("peer public key is a low-order point");
  const [chain2, timestampKey] = kdf(2, chainingKey, staticShared);
  chainingKey = chain2;
  const encryptedTimestamp = aeadEncrypt(timestampKey, 0n, tai64n(), h);
  encryptedTimestamp.copy(message, INIT_TIMESTAMP);
  h = hash(h, encryptedTimestamp);

  mac(mac1Key(keys.peerPublicKey), message.subarray(0, INIT_MAC1)).copy(message, INIT_MAC1);
  // mac2 stays zero. It is only non-zero once a peer has answered with a cookie
  // reply, which happens under load; see consumeCookieReply's absence below.

  return {
    message,
    state: {
      senderIndex,
      chainingKey,
      hash: h,
      ephemeralPrivate: ephemeral.privateKey,
      keys,
    },
  };
}

export function consumeResponse(state: HandshakeState, message: Buffer): TransportKeys {
  if (message.length !== RESPONSE_LENGTH) {
    throw new Error(`handshake response is ${message.length} bytes, want ${RESPONSE_LENGTH}`);
  }
  if (message.readUInt8(0) !== MESSAGE_RESPONSE) {
    throw new Error(`not a handshake response (type ${message.readUInt8(0)})`);
  }
  const receiver = message.readUInt32LE(RESP_RECEIVER);
  if (receiver !== state.senderIndex) {
    throw new Error("handshake response is for a different session");
  }

  // Checked before any DH: the mac proves the sender holds our public key, and
  // verifying it first is what keeps an unauthenticated packet from costing us
  // scalar multiplications.
  const expectedMac1 = mac(mac1Key(state.keys.publicKey), message.subarray(0, RESP_MAC1));
  if (!equal(expectedMac1, message.subarray(RESP_MAC1, RESP_MAC1 + 16))) {
    throw new Error("handshake response mac1 does not verify");
  }

  const peerEphemeral = message.subarray(RESP_EPHEMERAL, RESP_EPHEMERAL + 32);
  let chainingKey = state.chainingKey;
  let h = state.hash;

  [chainingKey] = kdf(1, chainingKey, peerEphemeral);
  h = hash(h, peerEphemeral);

  const ephemeralShared = dh(state.ephemeralPrivate, peerEphemeral);
  if (isAllZero(ephemeralShared)) throw new Error("peer ephemeral is a low-order point");
  [chainingKey] = kdf(1, chainingKey, ephemeralShared);

  const staticShared = dh(state.keys.privateKey, peerEphemeral);
  if (isAllZero(staticShared)) throw new Error("peer ephemeral is a low-order point");
  [chainingKey] = kdf(1, chainingKey, staticShared);

  // The psk enters here and nowhere else. Absent, it is 32 zero bytes, which is
  // not a special case in the maths — it is why a config without one still
  // interoperates with a peer that expects the same absence.
  const psk = state.keys.presharedKey ?? ZERO_PSK;
  const [chain, tau, emptyKey] = kdf(3, chainingKey, psk);
  chainingKey = chain;
  h = hash(h, tau);

  const encryptedEmpty = message.subarray(RESP_EMPTY, RESP_EMPTY + 16);
  const empty = aeadDecrypt(emptyKey, 0n, encryptedEmpty, h);
  if (empty.length !== 0) throw new Error("handshake response payload is not empty");

  // Order matters and is not symmetric: the INITIATOR takes (send, receive),
  // the responder takes them the other way round. Swap these and the handshake
  // still completes while every transport packet fails to authenticate — which
  // reads as a working tunnel that carries nothing.
  const [sendKey, receiveKey] = kdf(2, chainingKey, Buffer.alloc(0));

  return {
    sendKey,
    receiveKey,
    localIndex: state.senderIndex,
    remoteIndex: message.readUInt32LE(RESP_SENDER),
  };
}

export function messageType(datagram: Buffer): number {
  return datagram.length >= 1 ? datagram.readUInt8(0) : -1;
}

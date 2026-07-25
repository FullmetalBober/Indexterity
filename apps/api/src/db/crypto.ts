import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { managedNonce, randomBytes } from "@noble/ciphers/utils.js";

// Master-key custodian. v1 = env; later Vault/KMS — same interface, swap impl.
export interface KeyProvider {
  wrap(dek: Uint8Array): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>;
}

// v1 custodian: 32-byte master key injected via env / Docker secret (never in git).
export function envKeyProvider(masterKey: Uint8Array): KeyProvider {
  const kek = managedNonce(xchacha20poly1305)(masterKey);
  return {
    wrap: (dek) => Promise.resolve(kek.encrypt(dek)),
    unwrap: (wrapped) => Promise.resolve(kek.decrypt(wrapped)),
  };
}

export interface Sealed {
  readonly dek: Uint8Array;
  readonly data: Uint8Array;
}

// Envelope encryption: a random per-secret DEK encrypts the data; the KEK wraps
// the DEK. managedNonce prepends a random 24-byte nonce (reuse-safe).
export async function seal(plaintext: Uint8Array, kp: KeyProvider): Promise<Sealed> {
  const dek = randomBytes(32);
  const cipher = managedNonce(xchacha20poly1305)(dek);
  return { dek: await kp.wrap(dek), data: cipher.encrypt(plaintext) };
}

export async function open(sealed: Sealed, kp: KeyProvider): Promise<Uint8Array> {
  const dek = await kp.unwrap(sealed.dek);
  return managedNonce(xchacha20poly1305)(dek).decrypt(sealed.data);
}

import { createHmac } from "node:crypto";

// Enough RFC 6238 to sign in during a test: base32 secret, HMAC-SHA1, 6
// digits, 30-second period — better-auth's defaults. The suite plays the
// authenticator app, so the enrolment and sign-in flows are exercised the way
// a phone would, not through a backdoor that skips the code.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

export function secretFromTotpUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get("secret");
  if (secret === null) throw new Error(`no secret in ${totpURI}`);
  return secret;
}

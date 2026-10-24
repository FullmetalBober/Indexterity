// A Content-Security-Policy nonce, minted per response (see security-headers.ts
// for why the dashboard's scripts are allowed by nonce at all).
//
// The length is the security property: a value an attacker can guess is a value
// they can put on their own script tag. 128 bits, base64, per response and never
// reused — the CSP specification's own floor.
//
// Web Crypto rather than node:crypto, because the router mints it (router.tsx),
// and that module is in the browser's bundle as well as the server's. Only the
// server ever calls it.
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

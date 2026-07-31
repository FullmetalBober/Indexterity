// Whether the session cookie must carry `Secure`.
//
// CSRF itself is already handled: better-auth issues the cookie SameSite=Lax,
// so a cross-site POST/PATCH/DELETE carries no cookie at all, and every GET in
// the contract is a read (Lax does send cookies on top-level GET navigation, so
// a state-changing GET would be the one hole — contract.get.test.ts pins that).
//
// What Lax does NOT do is keep the cookie off plaintext. better-auth infers
// `Secure` from the baseURL scheme, which means a deployment terminating TLS at
// an ingress and passing http:// inward silently ships a session cookie that
// any network hop can read. Decide it explicitly instead of inheriting it.
export function useSecureCookies(baseURL: string, nodeEnv: string | undefined): boolean {
  return baseURL.startsWith("https://") || nodeEnv === "production";
}

// A production deploy whose baseURL is not https is almost always a mistake in
// the ingress wiring, and its symptom — a cookie without Secure — is invisible
// until someone looks at response headers. Fail the boot instead.
export function assertProductionUrl(baseURL: string, nodeEnv: string | undefined): void {
  if (nodeEnv !== "production") return;
  if (baseURL.startsWith("https://")) return;
  throw new Error(
    `BETTER_AUTH_URL must be https in production (got "${baseURL}"). ` +
      `Set it to the api's public https origin; the session cookie's Secure flag depends on it.`,
  );
}

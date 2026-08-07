export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env: ${name}`);
  }
  return value;
}

export function masterKeyBytes(): Uint8Array {
  return Buffer.from(requiredEnv("MASTER_KEY"), "base64");
}

// KEK rotation: v1 = MASTER_KEY, v2+ = MASTER_KEY_V<n>. Each cluster row records
// the version that sealed it, so old rows stay readable during a rotation.
export function masterKeyBytesFor(version: number): Uint8Array {
  const name = version <= 1 ? "MASTER_KEY" : `MASTER_KEY_V${version}`;
  return Buffer.from(requiredEnv(name), "base64");
}

// The version new seals are written with (bump alongside adding MASTER_KEY_V<n>).
export function currentKeyVersion(): number {
  const raw = Number(process.env.MASTER_KEY_VERSION);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

// An optional numeric knob. Anything that is not a positive number — unset,
// empty, a typo, zero — falls back to the default rather than silently
// disabling the thing it configures.
export function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Fastify's trustProxy, from the environment.
//
// Behind an ingress or a Service every request arrives from the proxy, so
// `request.ip` is the proxy's address and both rate limiters — Fastify's and
// better-auth's — collapse from per-client budgets into one global bucket. One
// noisy client then exhausts the auth budget for everyone, and a brute-force
// attempt is indistinguishable from ordinary traffic.
//
// Off by default and opt-in on purpose: trusting X-Forwarded-For while directly
// exposed is worse than not resolving the address at all, because then any
// client can forge a fresh IP per request and never hit a limit.
//
// Accepts "true", a hop count ("1" — trust the last N proxies), or a CIDR list
// ("10.0.0.0/8,192.168.0.0/16"). Anything else means do not trust.
export function trustProxySetting(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return hops;
  return raw;
}

export function trustsProxy(): boolean {
  return trustProxySetting() !== false;
}

// The CIDR entries of TRUST_PROXY, for better-auth, which needs to know WHICH
// hops to distrust rather than only that a proxy exists.
//
// Fastify accepts "true" and a hop count as well, and better-auth has no
// equivalent for either: without a list it trusts a forwarded header only when
// it carries exactly one address, and behind an ingress the header usually
// carries two or more (client, ingress). Every hop then goes unresolved, which
// is not a broken limit but a shared one — every client lands in the same bucket
// (#54). A CIDR list is the way to get per-client budgets out of it.
//
// Pure over its argument so the parsing is testable; `trustedProxyCidrs` is the
// environment's answer.
export function cidrEntries(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(entry) && /[.:]/.test(entry));
}

export function trustedProxyCidrs(): string[] {
  return cidrEntries(process.env.TRUST_PROXY);
}

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

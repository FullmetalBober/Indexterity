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

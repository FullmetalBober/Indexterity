// swc mirrors src/ into dist/, so ../package.json is apps/api/package.json from
// both. Read once: it cannot change while the process runs, and both the meter
// and the error reporter want it at startup.
import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(`${__dirname}/../package.json`, "utf8"));
    if (typeof raw === "object" && raw !== null) {
      const version: unknown = Reflect.get(raw, "version");
      if (typeof version === "string") return version;
    }
  } catch {
    // Not fatal: an unknown version is worth less than a crashed process.
  }
  return "unknown";
}

export const APP_VERSION: string = readVersion();

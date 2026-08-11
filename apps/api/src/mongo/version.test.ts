import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env";
import {
  hasQueryStatsPlanMetrics,
  meetsVersionFloor,
  parseServerVersion,
  unsupportedVersionMessage,
  versionRefusal,
} from "./version";

describe("parseServerVersion", () => {
  it("reads major and minor from a build string", () => {
    expect(parseServerVersion("6.0.28")).toEqual({ major: 6, minor: 0, text: "6.0.28" });
    expect(parseServerVersion("4.4.30-rc1")).toEqual({ major: 4, minor: 4, text: "4.4.30-rc1" });
  });

  it("returns null for anything it cannot read", () => {
    expect(parseServerVersion("")).toBeNull();
    expect(parseServerVersion("banana")).toBeNull();
    expect(parseServerVersion(undefined)).toBeNull();
    expect(parseServerVersion(7)).toBeNull();
  });
});

describe("meetsVersionFloor", () => {
  it("is true from 6.0 upwards", () => {
    for (const v of ["6.0.0", "6.0.28", "7.0.39", "8.2.9"]) {
      expect(meetsVersionFloor(parseServerVersion(v))).toBe(true);
    }
  });

  // 4.4 and 5.0 CAN hide indexes; they are refused as end-of-life, not as
  // incapable. 4.2 genuinely cannot — verified against a real 4.2 server.
  it("is false below 6.0", () => {
    for (const v of ["5.0.33", "4.4.30", "4.2.24", "3.6.23"]) {
      expect(meetsVersionFloor(parseServerVersion(v))).toBe(false);
    }
  });

  // An unknown version must not be optimistically treated as modern: the whole
  // point is to never attempt a write the server cannot do.
  it("is false when the version could not be read", () => {
    expect(meetsVersionFloor(null)).toBe(false);
  });
});

// Verified live: absent on 6.0.28 and 7.0.39, present on 8.2.9.
describe("hasQueryStatsPlanMetrics", () => {
  it("is true from 8.0 upwards", () => {
    for (const v of ["8.0.0", "8.2.9"]) {
      expect(hasQueryStatsPlanMetrics(parseServerVersion(v))).toBe(true);
    }
  });

  it("is false on the 6.x and 7.x stores, which count executions only", () => {
    for (const v of ["6.0.28", "7.0.39"]) {
      expect(hasQueryStatsPlanMetrics(parseServerVersion(v))).toBe(false);
    }
    expect(hasQueryStatsPlanMetrics(null)).toBe(false);
  });
});

describe("unsupportedVersionMessage", () => {
  it("names the version and why it is refused", () => {
    const message = unsupportedVersionMessage(parseServerVersion("5.0.33"));
    expect(message).toContain("5.0.33");
    expect(message).toContain("6.0");
    expect(message).toContain("end-of-life");
  });
});

// Read from the validated environment, which is parsed once at boot — so a test
// that wants a different one says when the process read it.
afterEach(() => {
  delete process.env.ALLOW_UNTESTED_MONGO_VERSION;
  loadEnv("api");
});

describe("version ceiling", () => {
  it("accepts the tested range", () => {
    for (const v of ["6.0.28", "7.0.39", "8.2.9"]) {
      expect(versionRefusal(parseServerVersion(v))).toBeNull();
    }
  });

  it("refuses a major series newer than anything tested", () => {
    const refusal = versionRefusal(parseServerVersion("9.0.0"));
    expect(refusal).toContain("newer than the 8.x series");
    expect(refusal).toContain("ALLOW_UNTESTED_MONGO_VERSION");
  });

  it("lets an operator opt in to an untested release", () => {
    process.env.ALLOW_UNTESTED_MONGO_VERSION = "true";
    loadEnv("api");
    expect(versionRefusal(parseServerVersion("9.0.0"))).toBeNull();
    // The floor is NOT overridable — the ceiling escape hatch does not open it.
    expect(versionRefusal(parseServerVersion("5.0.33"))).toContain("end-of-life");
  });

  it("prefers the floor's explanation when a version is unreadable", () => {
    expect(versionRefusal(null)).toContain("end-of-life");
  });
});

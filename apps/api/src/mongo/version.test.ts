import { describe, expect, it } from "vitest";
import {
  parseServerVersion,
  supportsHiddenIndexes,
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

describe("supportsHiddenIndexes", () => {
  it("is true from 4.4 upwards", () => {
    for (const v of ["4.4.0", "4.4.30", "5.0.1", "6.0.28", "7.0.39", "8.2.9"]) {
      expect(supportsHiddenIndexes(parseServerVersion(v))).toBe(true);
    }
  });

  it("is false below 4.4 — verified against a real 4.2 server", () => {
    for (const v of ["4.2.24", "4.0.0", "3.6.23"]) {
      expect(supportsHiddenIndexes(parseServerVersion(v))).toBe(false);
    }
  });

  // An unknown version must not be optimistically treated as modern: the whole
  // point is to never attempt a write the server cannot do.
  it("is false when the version could not be read", () => {
    expect(supportsHiddenIndexes(null)).toBe(false);
  });
});

describe("unsupportedVersionMessage", () => {
  it("names the version and says what still works", () => {
    const message = unsupportedVersionMessage(parseServerVersion("4.2.24"));
    expect(message).toContain("4.2.24");
    expect(message).toContain("4.4 or newer");
    expect(message).toContain("creation still work");
  });
});

describe("version ceiling", () => {
  it("accepts the tested range", () => {
    for (const v of ["4.4.30", "6.0.28", "7.0.39", "8.2.9"]) {
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
    try {
      expect(versionRefusal(parseServerVersion("9.0.0"))).toBeNull();
      // The floor is NOT overridable — below it the pipeline cannot run at all.
      expect(versionRefusal(parseServerVersion("4.2.24"))).toContain("cannot hide indexes");
    } finally {
      delete process.env.ALLOW_UNTESTED_MONGO_VERSION;
    }
  });

  it("prefers the floor's explanation when a version is unreadable", () => {
    expect(versionRefusal(null)).toContain("cannot hide indexes");
  });
});

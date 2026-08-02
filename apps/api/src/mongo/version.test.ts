import { describe, expect, it } from "vitest";
import { parseServerVersion, supportsHiddenIndexes, unsupportedVersionMessage } from "./version";

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

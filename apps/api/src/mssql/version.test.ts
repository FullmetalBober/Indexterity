import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env";
import { mssqlVersionRefusal, parseMssqlVersion } from "./version";

// Read from the validated environment, parsed once at boot — a test that wants
// a different one says when the process read it (same shape as mongo's).
afterEach(() => {
  delete process.env.ALLOW_UNTESTED_MSSQL_VERSION;
  loadEnv("api");
});

describe("parseMssqlVersion", () => {
  it("parses ProductVersion", () => {
    expect(parseMssqlVersion("16.0.4250.1")).toEqual({ major: 16, minor: 0, text: "16.0.4250.1" });
  });
  it("treats junk as unreadable", () => {
    expect(parseMssqlVersion(undefined)).toBeNull();
    expect(parseMssqlVersion("vNext")).toBeNull();
  });
});

describe("mssqlVersionRefusal", () => {
  it("accepts 2016 through 2025", () => {
    expect(mssqlVersionRefusal(parseMssqlVersion("13.0.5026.0"))).toBeNull();
    expect(mssqlVersionRefusal(parseMssqlVersion("15.0.4360.2"))).toBeNull();
    expect(mssqlVersionRefusal(parseMssqlVersion("16.0.4250.1"))).toBeNull();
    expect(mssqlVersionRefusal(parseMssqlVersion("17.0.4075.5"))).toBeNull();
  });

  it("refuses below the 2016 floor, naming the product", () => {
    expect(mssqlVersionRefusal(parseMssqlVersion("12.0.6024.0"))).toContain("2016");
  });

  it("refuses an unreadable version", () => {
    expect(mssqlVersionRefusal(null)).toContain("unreadable");
  });

  it("refuses newer than tested, naming the escape hatch", () => {
    expect(mssqlVersionRefusal(parseMssqlVersion("18.0.100.0"))).toContain(
      "ALLOW_UNTESTED_MSSQL_VERSION",
    );
  });

  it("lets an operator opt in to an untested release — the floor stays shut", () => {
    process.env.ALLOW_UNTESTED_MSSQL_VERSION = "true";
    loadEnv("api");
    expect(mssqlVersionRefusal(parseMssqlVersion("18.0.100.0"))).toBeNull();
    expect(mssqlVersionRefusal(parseMssqlVersion("12.0.6024.0"))).toContain("2016");
  });
});

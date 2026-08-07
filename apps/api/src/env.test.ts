import { afterEach, describe, expect, it } from "vitest";
import { cidrEntries, trustProxySetting, trustsProxy } from "./env";

// Behind an ingress, an untrusted forwarded address turns every per-IP rate
// limit into one shared bucket; a blindly trusted one lets a client forge a
// fresh address per request. Both failures are silent, so the parsing is worth
// pinning.
describe("trustProxySetting", () => {
  const previous = process.env.TRUST_PROXY;
  afterEach(() => {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  });

  it("does not trust anything by default", () => {
    delete process.env.TRUST_PROXY;
    expect(trustProxySetting()).toBe(false);
    expect(trustsProxy()).toBe(false);
  });

  it("reads an explicit true", () => {
    process.env.TRUST_PROXY = "true";
    expect(trustProxySetting()).toBe(true);
    expect(trustsProxy()).toBe(true);
  });

  it("reads a hop count as a number, not a string", () => {
    process.env.TRUST_PROXY = "2";
    expect(trustProxySetting()).toBe(2);
  });

  it("passes a CIDR list through for fastify to match on", () => {
    process.env.TRUST_PROXY = "10.0.0.0/8,192.168.0.0/16";
    expect(trustProxySetting()).toBe("10.0.0.0/8,192.168.0.0/16");
  });

  it("treats an empty or false value as untrusted", () => {
    for (const value of ["", "  ", "false"]) {
      process.env.TRUST_PROXY = value;
      expect(trustProxySetting()).toBe(false);
    }
  });
});

// The same variable, read a second way. Fastify takes "true" and a hop count;
// better-auth takes neither and needs the ranges by name, or it cannot tell the
// client from the proxy in a two-hop X-Forwarded-For and puts every caller in one
// rate-limit bucket (#54).
describe("cidrEntries", () => {
  it("keeps the ranges of a CIDR list", () => {
    expect(cidrEntries("10.0.0.0/8, 192.168.0.0/16")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });

  it("keeps a bare address, which is a /32 by any other name", () => {
    expect(cidrEntries("10.4.1.7")).toEqual(["10.4.1.7"]);
  });

  it("keeps IPv6 ranges", () => {
    expect(cidrEntries("fd00::/8")).toEqual(["fd00::/8"]);
  });

  // "true" and "2" are Fastify's dialects, and handing either to better-auth as a
  // range would be a list it silently never matches.
  it("drops what is not an address at all", () => {
    for (const value of ["true", "false", "2", "", "  "]) {
      expect(cidrEntries(value)).toEqual([]);
    }
    expect(cidrEntries(undefined)).toEqual([]);
  });

  it("keeps only the address-shaped entries of a mixed list", () => {
    expect(cidrEntries("true,10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });
});

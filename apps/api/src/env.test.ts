import { afterEach, describe, expect, it } from "vitest";
import { trustProxySetting, trustsProxy } from "./env";

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

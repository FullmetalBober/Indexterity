import { describe, expect, it } from "vitest";
import { isTrustProxyValue, proxyTrustedBy } from "./env";

// The chart hands this pod the same TRUST_PROXY it hands the api, and that is
// usually a CIDR list rather than the word "true". Reading it as a boolean is
// how a configured proxy read as "no proxy": the passthrough then stripped
// x-forwarded-for, and every caller landed in one rate-limit bucket on the api
// behind it — the exact failure #54 is about, on the other side of the hop.
describe("proxyTrustedBy", () => {
  it("trusts every dialect that names a proxy", () => {
    for (const value of ["true", "1", "2", "10.0.0.0/8", "10.0.0.0/8,192.168.0.0/16"]) {
      expect(proxyTrustedBy(value), value).toBe(true);
    }
  });

  it("trusts nothing when nothing is in front", () => {
    for (const value of ["false", "", "  "]) {
      expect(proxyTrustedBy(value), JSON.stringify(value)).toBe(false);
    }
  });
});

// Absent is fine, malformed is fatal — the same rule as the api's schema. A
// typo here is not a smaller version of "no proxy": it is a deployment that
// believes it configured one.
describe("isTrustProxyValue", () => {
  it("accepts the three dialects", () => {
    for (const value of ["true", "false", "1", "10.0.0.0/8", "fd00::/8", "10.4.1.7"]) {
      expect(isTrustProxyValue(value), value).toBe(true);
    }
  });

  it("refuses what is none of them", () => {
    for (const value of ["ture", "yes", "0", "10.0.0.0/8,nonsense", "-1"]) {
      expect(isTrustProxyValue(value), value).toBe(false);
    }
  });
});

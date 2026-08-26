import { describe, expect, it } from "vitest";
import { assertDialableThroughTunnel, parseCidr, TunnelTargetError, withinCidr } from "./guard";

const cidrs = (...entries: string[]) => entries.map(parseCidr);

describe("withinCidr", () => {
  it("matches inside a v4 prefix and not outside it", () => {
    expect(withinCidr("10.1.2.3", parseCidr("10.0.0.0/8"))).toBe(true);
    expect(withinCidr("11.1.2.3", parseCidr("10.0.0.0/8"))).toBe(false);
  });

  it("handles a prefix that is not on a byte boundary", () => {
    expect(withinCidr("192.168.3.1", parseCidr("192.168.0.0/22"))).toBe(true);
    expect(withinCidr("192.168.4.1", parseCidr("192.168.0.0/22"))).toBe(false);
  });

  it("treats a bare address as a single host", () => {
    expect(withinCidr("10.0.0.1", parseCidr("10.0.0.1"))).toBe(true);
    expect(withinCidr("10.0.0.2", parseCidr("10.0.0.1"))).toBe(false);
  });

  it("matches inside a v6 prefix, including a compressed one", () => {
    expect(withinCidr("fd00::1", parseCidr("fd00::/8"))).toBe(true);
    expect(withinCidr("fd12:3456::9", parseCidr("fd12:3456::/32"))).toBe(true);
    expect(withinCidr("fe80::1", parseCidr("fd00::/8"))).toBe(false);
  });

  // Without this a v4 address could match a v6 prefix on a shared bit pattern,
  // which is a hole nobody would ever think to look for.
  it("never matches across families", () => {
    expect(withinCidr("10.0.0.1", parseCidr("fd00::/8"))).toBe(false);
    expect(withinCidr("fd00::1", parseCidr("10.0.0.0/8"))).toBe(false);
  });

  it("matches everything on a zero-length prefix", () => {
    expect(withinCidr("8.8.8.8", parseCidr("0.0.0.0/0"))).toBe(true);
  });
});

describe("parseCidr", () => {
  it("refuses a non-address and an impossible prefix", () => {
    expect(() => parseCidr("nope/8")).toThrow(TunnelTargetError);
    expect(() => parseCidr("10.0.0.0/33")).toThrow(/impossible prefix/);
    expect(() => parseCidr("fd00::/129")).toThrow(/impossible prefix/);
  });
});

describe("assertDialableThroughTunnel", () => {
  const allowed = cidrs("10.0.0.0/8", "192.168.0.0/16");

  it("allows a private address inside AllowedIPs — the whole point of a tunnel", () => {
    expect(() => assertDialableThroughTunnel("10.4.5.6", allowed)).not.toThrow();
    expect(() => assertDialableThroughTunnel("192.168.1.1", allowed)).not.toThrow();
  });

  it("refuses a private address the peer did not agree to carry", () => {
    expect(() => assertDialableThroughTunnel("172.16.0.1", allowed)).toThrow(/outside this tunnel/);
  });

  // The one that matters. A route to it is not permission to read it.
  it("refuses cloud metadata even when AllowedIPs covers it", () => {
    expect(() => assertDialableThroughTunnel("169.254.169.254", cidrs("0.0.0.0/0"))).toThrow(
      /never a database/,
    );
  });

  it("refuses the other never-a-database ranges inside a tunnel", () => {
    const everything = cidrs("0.0.0.0/0", "::/0");
    for (const address of ["224.0.0.1", "240.0.0.1", "0.0.0.0", "192.0.2.1"]) {
      expect(() => assertDialableThroughTunnel(address, everything)).toThrow(TunnelTargetError);
    }
    expect(() => assertDialableThroughTunnel("fe80::1", everything)).toThrow(/never a database/);
  });

  it("allows a public address when the peer routes it, since some VPNs do", () => {
    expect(() => assertDialableThroughTunnel("8.8.8.8", cidrs("0.0.0.0/0"))).not.toThrow();
  });

  it("refuses everything when AllowedIPs is empty", () => {
    expect(() => assertDialableThroughTunnel("10.0.0.1", [])).toThrow(/outside this tunnel/);
  });
});

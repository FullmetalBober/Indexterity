import { describe, expect, it } from "vitest";
import {
  assertDialableThroughTunnel,
  assertTargetsAllowed,
  BlockedTargetError,
  classifyAddress,
  parseCidr,
} from "./net-guard";

function category(ip: string): string {
  return classifyAddress(ip).category;
}

describe("classifyAddress", () => {
  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "52.14.3.9", "2606:4700::1111"]) {
      expect(category(ip)).toBe("PUBLIC");
    }
  });

  it("marks RFC1918, loopback and CGNAT private (allowable on request)", () => {
    for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "127.0.0.1"]) {
      expect(category(ip)).toBe("PRIVATE");
    }
    expect(category("100.64.0.1")).toBe("PRIVATE");
    expect(category("::1")).toBe("PRIVATE");
    expect(category("fd00::1")).toBe("PRIVATE");
  });

  it("forbids cloud metadata and other never-a-database ranges outright", () => {
    // The highest-value SSRF target: must stay blocked even when private
    // targets are allowed.
    expect(classifyAddress("169.254.169.254")).toEqual({
      category: "FORBIDDEN",
      reason: "link-local / cloud metadata",
    });
    for (const ip of ["0.0.0.0", "224.0.0.1", "240.0.0.1", "192.0.2.5", "198.18.0.1"]) {
      expect(category(ip)).toBe("FORBIDDEN");
    }
    expect(category("fe80::1")).toBe("FORBIDDEN");
    expect(category("ff02::1")).toBe("FORBIDDEN");
    expect(category("::")).toBe("FORBIDDEN");
  });

  it("sees through IPv4-mapped IPv6 (the classic bypass)", () => {
    expect(category("::ffff:10.0.0.5")).toBe("PRIVATE");
    expect(category("::ffff:127.0.0.1")).toBe("PRIVATE");
    expect(category("::ffff:169.254.169.254")).toBe("FORBIDDEN");
    expect(category("::ffff:8.8.8.8")).toBe("PUBLIC");
    // Hex form of 192.168.0.1.
    expect(category("::ffff:c0a8:0001")).toBe("PRIVATE");
  });

  it("gets CIDR boundaries right", () => {
    expect(category("172.15.255.255")).toBe("PUBLIC"); // just below 172.16/12
    expect(category("172.16.0.0")).toBe("PRIVATE");
    expect(category("172.31.255.255")).toBe("PRIVATE");
    expect(category("172.32.0.0")).toBe("PUBLIC"); // just above
    expect(category("9.255.255.255")).toBe("PUBLIC");
    expect(category("11.0.0.0")).toBe("PUBLIC");
    expect(category("100.63.255.255")).toBe("PUBLIC");
    expect(category("100.128.0.0")).toBe("PUBLIC");
  });

  it("rejects anything that is not an address", () => {
    for (const value of ["", "not-an-ip", "999.1.1.1", "1.2.3"]) {
      expect(category(value)).toBe("FORBIDDEN");
    }
  });
});

describe("assertTargetsAllowed", () => {
  const strict = { allowPrivate: false };
  const permissive = { allowPrivate: true };

  it("passes public IP literals", async () => {
    await expect(assertTargetsAllowed(["8.8.8.8:27017"], false, strict)).resolves.toBeUndefined();
  });

  it("blocks private literals unless allowed, and names the escape hatch", async () => {
    await expect(assertTargetsAllowed(["10.0.0.5:27017"], false, strict)).rejects.toThrow(
      /ALLOW_PRIVATE_CLUSTER_TARGETS/,
    );
    await expect(
      assertTargetsAllowed(["10.0.0.5:27017"], false, permissive),
    ).resolves.toBeUndefined();
  });

  it("blocks cloud metadata even when private targets are allowed", async () => {
    await expect(
      assertTargetsAllowed(["169.254.169.254:27017"], false, permissive),
    ).rejects.toThrow(BlockedTargetError);
  });

  it("checks EVERY host in a multi-host string", async () => {
    // One good host must not smuggle in a bad one.
    await expect(
      assertTargetsAllowed(["8.8.8.8:27017", "192.168.1.10:27018"], false, strict),
    ).rejects.toThrow(/192\.168\.1\.10/);
  });

  it("handles bracketed IPv6 hosts with ports", async () => {
    await expect(assertTargetsAllowed(["[::1]:27017"], false, strict)).rejects.toThrow(/loopback/);
    await expect(
      assertTargetsAllowed(["[2606:4700::1111]:27017"], false, strict),
    ).resolves.toBeUndefined();
  });

  it("lets unresolvable hosts through to fail as unreachable", async () => {
    await expect(
      assertTargetsAllowed(["no-such-host.invalid"], false, strict),
    ).resolves.toBeUndefined();
  });
});

// The check every tunnelled dial goes through, and — since the peering moved into
// a separate process (D111) — the ONLY place that decision is made. The binary
// asks and this answers, so an untested rule here is an unguarded dial.
describe("assertDialableThroughTunnel", () => {
  const carries = (...cidrs: string[]) => cidrs.map(parseCidr);

  it("allows an address the peer agreed to carry", () => {
    expect(() => assertDialableThroughTunnel("10.4.5.6", carries("10.0.0.0/8"))).not.toThrow();
  });

  it("refuses an address outside AllowedIPs, saying the peer did not agree to it", () => {
    expect(() => assertDialableThroughTunnel("192.168.5.5", carries("10.0.0.0/8"))).toThrow(
      /AllowedIPs/,
    );
  });

  // The one that matters most. A peering carrying 0.0.0.0/0 — which a full-tunnel
  // VPN exports — agrees to carry the metadata endpoint too, and the FORBIDDEN
  // tier has to outrank what a peer agreed to.
  it("refuses cloud metadata even when AllowedIPs covers it", () => {
    expect(() => assertDialableThroughTunnel("169.254.169.254", carries("0.0.0.0/0"))).toThrow(
      /never a database/,
    );
  });

  it("refuses link-local v6 inside a peering that covers everything", () => {
    expect(() => assertDialableThroughTunnel("fe80::1", carries("::/0"))).toThrow(
      /never a database/,
    );
  });

  // Proven end to end against a real v6-only peering (D111): a unique-local
  // address inside a v6 prefix is the shape that reaches this.
  it("allows a unique-local v6 address the peer carries", () => {
    expect(() => assertDialableThroughTunnel("fd00::1", carries("fd00::/64"))).not.toThrow();
  });

  it("refuses a v6 address outside the v6 prefix", () => {
    expect(() => assertDialableThroughTunnel("fd00:1::1", carries("fd00::/64"))).toThrow(
      /AllowedIPs/,
    );
  });

  // Families do not blur: a bit-string comparison that ignored the family would
  // match a v4 address against a v6 prefix on a shared leading run of zeroes.
  it("does not read a v4 address as inside a v6 prefix", () => {
    expect(() => assertDialableThroughTunnel("10.4.5.6", carries("fd00::/8"))).toThrow(
      /AllowedIPs/,
    );
    expect(() => assertDialableThroughTunnel("fd00::1", carries("10.0.0.0/8"))).toThrow(
      /AllowedIPs/,
    );
  });

  it("refuses everything when the peering carries nothing", () => {
    expect(() => assertDialableThroughTunnel("10.4.5.6", [])).toThrow(/AllowedIPs/);
  });
});

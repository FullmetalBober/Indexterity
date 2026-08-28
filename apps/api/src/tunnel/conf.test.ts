import { describe, expect, it } from "vitest";
import { InvalidWireGuardConfError, parseWireGuardConf } from "./conf";

// A real wg0.conf as a VPN admin exports one, base64 keys included.
const VALID = `
[Interface]
PrivateKey = 6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8=
Address = 10.9.0.2/32
DNS = 10.9.0.1
MTU = 1420

[Peer]
PublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
AllowedIPs = 10.0.0.0/8, 192.168.0.0/16
Endpoint = vpn.customer.example:51820
PersistentKeepalive = 25
`;

describe("parseWireGuardConf", () => {
  it("parses a config a VPN admin would export", () => {
    const conf = parseWireGuardConf(VALID);
    expect(conf.privateKey).toHaveLength(32);
    expect(conf.addresses).toEqual(["10.9.0.2/32"]);
    expect(conf.dns).toEqual(["10.9.0.1"]);
    expect(conf.mtu).toBe(1420);
    expect(conf.peer.publicKey).toHaveLength(32);
    expect(conf.peer.allowedIps).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    expect(conf.peer.endpoint).toEqual({ host: "vpn.customer.example", port: 51820 });
    expect(conf.peer.persistentKeepalive).toBe(25);
  });

  it("defaults MTU when the config omits it", () => {
    expect(parseWireGuardConf(VALID.replace("MTU = 1420\n", "")).mtu).toBe(1420);
  });

  it("treats DNS as optional", () => {
    expect(parseWireGuardConf(VALID.replace("DNS = 10.9.0.1\n", "")).dns).toEqual([]);
  });

  it("accepts PersistentKeepalive = off", () => {
    const conf = parseWireGuardConf(
      VALID.replace("PersistentKeepalive = 25", "PersistentKeepalive = off"),
    );
    expect(conf.peer.persistentKeepalive).toBeUndefined();
  });

  it("keeps a base64 key whose padding contains '='", () => {
    // The value is split on '=' and rejoined; a key ending in '=' would lose it
    // to a naive split, and then fail as "not a 32-byte key" for a reason that
    // has nothing to do with the key.
    expect(parseWireGuardConf(VALID).privateKey.toString("base64")).toBe(
      "6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8=",
    );
  });

  it("strips comments, whole-line and trailing", () => {
    const commented = VALID.replace(
      "Address = 10.9.0.2/32",
      "Address = 10.9.0.2/32 # our side",
    ).replace("[Peer]", "# the gateway\n[Peer]");
    expect(parseWireGuardConf(commented).addresses).toEqual(["10.9.0.2/32"]);
  });

  it("reads directives case-insensitively, as people actually write them", () => {
    expect(
      parseWireGuardConf(VALID.replace("AllowedIPs", "allowedips")).peer.allowedIps,
    ).toHaveLength(2);
  });

  it("takes a bracketed IPv6 endpoint", () => {
    const conf = parseWireGuardConf(
      VALID.replace("vpn.customer.example:51820", "[2001:db8::1]:51820"),
    );
    expect(conf.peer.endpoint).toEqual({ host: "2001:db8::1", port: 51820 });
  });
});

describe("parseWireGuardConf refusals", () => {
  const refuses = (mutate: (conf: string) => string, pattern: RegExp) => {
    expect(() => parseWireGuardConf(mutate(VALID))).toThrow(InvalidWireGuardConfError);
    expect(() => parseWireGuardConf(mutate(VALID))).toThrow(pattern);
  };

  it("refuses a missing PrivateKey", () => {
    refuses((c) => c.replace(/PrivateKey = .*\n/, ""), /no PrivateKey/);
  });

  it("refuses a key that is not 32 bytes", () => {
    refuses((c) => c.replace(/PrivateKey = .*\n/, "PrivateKey = c2hvcnQ=\n"), /not a 32-byte/);
  });

  it("refuses a missing Endpoint, because we dial out", () => {
    refuses((c) => c.replace(/Endpoint = .*\n/, ""), /dials out/);
  });

  it("refuses a missing AllowedIPs, which is what bounds the tunnel", () => {
    refuses((c) => c.replace(/AllowedIPs = .*\n/, ""), /no AllowedIPs/);
  });

  it("refuses a second [Peer], since a cluster tunnel reaches one gateway", () => {
    refuses(
      (c) =>
        `${c}\n[Peer]\nPublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=\nAllowedIPs = 10.0.0.0/8\nEndpoint = other:51820\n`,
      /exactly one gateway/,
    );
  });

  // The important one. Ignoring these would run a config whose author expects
  // side effects that never happen.
  it.each(["PostUp", "PreDown", "PostDown", "Table"])(
    "refuses the wg-quick directive %s",
    (directive) => {
      refuses((c) => c.replace("[Peer]", `${directive} = echo hi\n\n[Peer]`), /not wg-quick/);
    },
  );

  it("refuses an endpoint that is not host:port", () => {
    refuses(
      (c) => c.replace("vpn.customer.example:51820", "vpn.customer.example"),
      /not host:port/,
    );
  });

  it("refuses an impossible port", () => {
    refuses((c) => c.replace(":51820", ":70000"), /not a port/);
  });

  it("refuses an impossible prefix length", () => {
    refuses((c) => c.replace("10.0.0.0/8", "10.0.0.0/48"), /impossible prefix length/);
  });

  it("refuses an Address that is not an address", () => {
    refuses((c) => c.replace("10.9.0.2/32", "not-an-address/32"), /not an address/);
  });

  it("refuses an MTU that cannot carry a packet", () => {
    refuses((c) => c.replace("MTU = 1420", "MTU = 200"), /out of range/);
  });

  it("refuses an unknown section", () => {
    refuses((c) => `${c}\n[Router]\nX = 1\n`, /unknown section/);
  });

  it("refuses a line outside any section", () => {
    expect(() => parseWireGuardConf("PrivateKey = x\n")).toThrow(/outside any section/);
  });

  it("refuses two [Interface] sections", () => {
    refuses(
      (c) => c.replace("[Peer]", "[Interface]\nPrivateKey = x\n\n[Peer]"),
      /more than one \[Interface\]/,
    );
  });
});

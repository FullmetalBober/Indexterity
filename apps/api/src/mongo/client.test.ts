import { afterEach, describe, expect, it } from "vitest";
import { assertTlsEnforced, InsecureConnectionError, usesValidatedTls } from "./client";

afterEach(() => {
  process.env.ALLOW_INSECURE_CLUSTER_TLS = undefined;
  delete process.env.ALLOW_INSECURE_CLUSTER_TLS;
});

describe("usesValidatedTls", () => {
  // The scheme is the default nobody reads. mongodb+srv:// turns TLS on, which
  // is why Atlas customers were encrypted by accident rather than by policy —
  // and why a pasted mongodb://host/db sent SCRAM and every collection name in
  // the clear without anything objecting.
  it("takes the default from the scheme when the string does not say", () => {
    expect(usesValidatedTls("mongodb+srv://u:p@cluster.example.net/app")).toBe(true);
    expect(usesValidatedTls("mongodb://u:p@host:27017/app")).toBe(false);
  });

  it("lets the string overrule its own scheme, in both directions", () => {
    expect(usesValidatedTls("mongodb://u:p@host:27017/app?tls=true")).toBe(true);
    expect(usesValidatedTls("mongodb+srv://u:p@cluster.example.net/app?tls=false")).toBe(false);
  });

  // `ssl` is the driver's alias for `tls`. Reading only one of them would let a
  // plaintext string through on the spelling nobody checked.
  it("reads ssl as the alias it is", () => {
    expect(usesValidatedTls("mongodb://host:27017/?ssl=true")).toBe(true);
    expect(usesValidatedTls("mongodb+srv://cluster.example.net/?ssl=false")).toBe(false);
  });

  // TLS whose certificate nobody checks is a connection anyone in the path can
  // be. Counting it as encrypted would be enforcing the ceremony, not the
  // property.
  it("refuses TLS with validation switched off", () => {
    expect(usesValidatedTls("mongodb+srv://c.example.net/?tlsInsecure=true")).toBe(false);
    expect(usesValidatedTls("mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=true")).toBe(
      false,
    );
    expect(usesValidatedTls("mongodb://h:27017/?tls=true&tlsAllowInvalidHostnames=true")).toBe(
      false,
    );
    // Present and false is the setting NOT being used, which is fine.
    expect(usesValidatedTls("mongodb://h:27017/?tls=true&tlsInsecure=false")).toBe(true);
  });

  it("is not a TLS verdict on a string that does not parse", () => {
    expect(usesValidatedTls("not a connection string")).toBe(false);
  });
});

describe("assertTlsEnforced", () => {
  it("passes a TLS string and refuses a plaintext one by name", () => {
    expect(() => assertTlsEnforced("mongodb+srv://c.example.net/app")).not.toThrow();
    expect(() => assertTlsEnforced("mongodb://h:27017/app")).toThrow(InsecureConnectionError);
  });

  // Same shape as the address guard's message: say the switch, so an operator
  // reading a log knows what to set and does not go looking for it.
  it("names the escape hatch in the refusal", () => {
    expect(() => assertTlsEnforced("mongodb://h:27017/app")).toThrow(/ALLOW_INSECURE_CLUSTER_TLS/);
  });

  // The dev stack and both test suites dial a local mongod with no certificate.
  it("stands down when the deployment has opted out", () => {
    process.env.ALLOW_INSECURE_CLUSTER_TLS = "true";
    expect(() => assertTlsEnforced("mongodb://h:27017/app")).not.toThrow();
  });

  // Only the exact string. A truthy-looking value is a misconfiguration, and the
  // safe reading of one is "no".
  it("takes only a literal true", () => {
    process.env.ALLOW_INSECURE_CLUSTER_TLS = "1";
    expect(() => assertTlsEnforced("mongodb://h:27017/app")).toThrow(InsecureConnectionError);
  });
});

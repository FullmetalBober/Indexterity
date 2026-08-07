import { afterEach, describe, expect, it } from "vitest";
import {
  applyTlsOverrides,
  assertTlsEnforced,
  InsecureConnectionError,
  unconsentedTlsOverrides,
  usesTls,
} from "./client";

const NONE = { allowInvalidCertificates: false, allowInvalidHostnames: false, insecure: false };
const CERTS = { ...NONE, allowInvalidCertificates: true };

afterEach(() => {
  process.env.ALLOW_INSECURE_CLUSTER_TLS = undefined;
  delete process.env.ALLOW_INSECURE_CLUSTER_TLS;
});

describe("usesTls", () => {
  // The scheme is the default nobody reads. mongodb+srv:// turns TLS on, which
  // is why Atlas customers were encrypted by accident rather than by policy —
  // and why a pasted mongodb://host/db sent SCRAM and every collection name in
  // the clear without anything objecting.
  it("takes the default from the scheme when the string does not say", () => {
    expect(usesTls("mongodb+srv://u:p@cluster.example.net/app")).toBe(true);
    expect(usesTls("mongodb://u:p@host:27017/app")).toBe(false);
  });

  it("lets the string overrule its own scheme, in both directions", () => {
    expect(usesTls("mongodb://u:p@host:27017/app?tls=true")).toBe(true);
    expect(usesTls("mongodb+srv://u:p@cluster.example.net/app?tls=false")).toBe(false);
  });

  // `ssl` is the driver's alias for `tls`. Reading only one of them would let a
  // plaintext string through on the spelling nobody checked.
  it("reads ssl as the alias it is", () => {
    expect(usesTls("mongodb://host:27017/?ssl=true")).toBe(true);
    expect(usesTls("mongodb+srv://cluster.example.net/?ssl=false")).toBe(false);
  });

  // Encryption only. Whether the certificate is CHECKED is a separate question
  // with a separate answer (unconsentedTlsOverrides), because an owner can
  // choose to skip that and cannot choose to skip this.
  it("answers only whether the transport is encrypted", () => {
    expect(usesTls("mongodb+srv://c.example.net/?tlsInsecure=true")).toBe(true);
    expect(usesTls("mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=true")).toBe(true);
  });

  it("is not a TLS verdict on a string that does not parse", () => {
    expect(usesTls("not a connection string")).toBe(false);
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

// The three options are refused by default and permitted per cluster, as
// checkboxes on the connect form — a private CA and an SSH tunnel are real
// reasons to need one, and neither is a reason to give up the other.
describe("unconsentedTlsOverrides", () => {
  it("names what the string turns off without permission", () => {
    expect(
      unconsentedTlsOverrides("mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=true"),
    ).toEqual(["tlsAllowInvalidCertificates"]);
  });

  it("says nothing about an option the owner ticked", () => {
    expect(
      unconsentedTlsOverrides(
        "mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=true",
        CERTS,
      ),
    ).toEqual([]);
  });

  // Consent is per option, not a blanket. Ticking "allow invalid certificates"
  // must not quietly permit tlsInsecure, which also accepts expired ones.
  it("does not let one consent cover another option", () => {
    expect(unconsentedTlsOverrides("mongodb://h:27017/?tls=true&tlsInsecure=true", CERTS)).toEqual([
      "tlsInsecure",
    ]);
  });

  it("ignores an option that is present and false", () => {
    expect(
      unconsentedTlsOverrides("mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=false"),
    ).toEqual([]);
  });
});

describe("assertTlsEnforced with consent", () => {
  it("refuses an unconsented option and names it", () => {
    expect(() =>
      assertTlsEnforced("mongodb://h:27017/?tls=true&tlsAllowInvalidHostnames=true"),
    ).toThrow(/tlsAllowInvalidHostnames/);
  });

  it("allows it once the owner has ticked the box", () => {
    expect(() =>
      assertTlsEnforced("mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=true", CERTS),
    ).not.toThrow();
  });

  // Consent is about the certificate, never about the encryption. There is no
  // checkbox that turns TLS off.
  it("still refuses plaintext however much is consented to", () => {
    expect(() =>
      assertTlsEnforced("mongodb://h:27017/app", {
        allowInvalidCertificates: true,
        allowInvalidHostnames: true,
        insecure: true,
      }),
    ).toThrow(InsecureConnectionError);
  });
});

describe("applyTlsOverrides", () => {
  it("writes a ticked box into the string, so nobody hand-edits one", () => {
    const out = applyTlsOverrides("mongodb://h:27017/app?tls=true", CERTS);
    expect(out).toContain("tlsallowinvalidcertificates=true");
    expect(out).not.toContain("tlsallowinvalidhostnames");
  });

  // Authoritative in both directions. Otherwise the form would show three
  // cleared boxes above a string that quietly disables all three — a worse lie
  // than refusing would have been.
  it("removes an option that was pasted in but not ticked", () => {
    const out = applyTlsOverrides(
      "mongodb://h:27017/app?tls=true&tlsAllowInvalidCertificates=true",
      NONE,
    );
    expect(out.toLowerCase()).not.toContain("tlsallowinvalidcertificates");
    // And the rest of the string is untouched.
    expect(out).toContain("tls=true");
    expect(out).toContain("h:27017");
  });

  // The driver reads these case-insensitively, so a pasted camelCase spelling
  // must not survive beside the lowercase one we write.
  it("does not leave a second spelling of the same option behind", () => {
    const out = applyTlsOverrides(
      "mongodb://h:27017/app?tls=true&tlsAllowInvalidCertificates=false",
      CERTS,
    );
    expect(out.toLowerCase().match(/tlsallowinvalidcertificates/g)).toHaveLength(1);
    expect(out).toContain("tlsallowinvalidcertificates=true");
  });

  it("leaves a string it cannot parse for the scheme guard to refuse", () => {
    expect(applyTlsOverrides("not a connection string", CERTS)).toBe("not a connection string");
  });
});

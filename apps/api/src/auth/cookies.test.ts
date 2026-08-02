import { describe, expect, it } from "vitest";
import { assertProductionUrl, useSecureCookies } from "./cookies";

describe("useSecureCookies", () => {
  it("is on for an https origin, and for production whatever the scheme says", () => {
    expect(useSecureCookies("https://api.example.com", undefined)).toBe(true);
    expect(useSecureCookies("http://api", "production")).toBe(true);
  });

  it("is off for local development", () => {
    expect(useSecureCookies("http://localhost:3001", "development")).toBe(false);
    expect(useSecureCookies("http://localhost:3001", undefined)).toBe(false);
  });
});

describe("assertProductionUrl", () => {
  it("refuses to boot production on a plaintext origin", () => {
    expect(() => assertProductionUrl("http://api:3001", "production")).toThrow(/must be https/);
  });

  it("allows https in production and anything outside it", () => {
    expect(() => assertProductionUrl("https://api.example.com", "production")).not.toThrow();
    expect(() => assertProductionUrl("http://localhost:3001", "development")).not.toThrow();
  });
});

// A cluster with no TLS anywhere — a Kind smoke test — still runs images that
// say NODE_ENV=production, and there is no ingress there to misconfigure.
describe("ALLOW_INSECURE_AUTH_URL", () => {
  it("lets an http baseURL boot when explicitly opted in", () => {
    process.env.ALLOW_INSECURE_AUTH_URL = "true";
    try {
      expect(() => assertProductionUrl("http://indexterity-api:3001", "production")).not.toThrow();
    } finally {
      delete process.env.ALLOW_INSECURE_AUTH_URL;
    }
  });

  it("still refuses without it, and names the switch", () => {
    expect(() => assertProductionUrl("http://indexterity-api:3001", "production")).toThrow(
      /ALLOW_INSECURE_AUTH_URL/,
    );
  });

  // The cookie is still marked Secure in production — the switch only silences
  // the boot check, it does not downgrade the cookie.
  it("does not change the Secure flag", () => {
    process.env.ALLOW_INSECURE_AUTH_URL = "true";
    try {
      expect(useSecureCookies("http://indexterity-api:3001", "production")).toBe(true);
    } finally {
      delete process.env.ALLOW_INSECURE_AUTH_URL;
    }
  });
});

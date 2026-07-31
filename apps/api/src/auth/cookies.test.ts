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

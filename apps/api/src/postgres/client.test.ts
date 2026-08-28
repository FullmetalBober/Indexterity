import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_TLS_OVERRIDES } from "../engine/ports";
import { InsecureConnectionError } from "../engine/tls";
import { assertPgTlsEnforced } from "./client";

const allowInsecure = vi.hoisted(() => vi.fn(() => false));
// The deployment-wide escape hatch is engine/tls.ts and reads env, which is
// exactly why the assert sits here rather than in conn-string.ts.
vi.mock("../engine/tls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engine/tls")>()),
  allowInsecureTls: allowInsecure,
}));

beforeEach(() => allowInsecure.mockReturnValue(false));

const boxes = (partial: Partial<typeof NO_TLS_OVERRIDES>) => ({ ...NO_TLS_OVERRIDES, ...partial });

describe("assertPgTlsEnforced", () => {
  it("accepts verify-full and refuses plaintext", () => {
    expect(() => assertPgTlsEnforced("postgresql://u@h/db?sslmode=verify-full")).not.toThrow();
    expect(() => assertPgTlsEnforced("postgresql://u@h/db?sslmode=disable")).toThrow(
      /refusing to connect/,
    );
  });

  // ALLOW_INSECURE_CLUSTER_TLS is a posture the operator sets for a whole
  // deployment, and it has to reach this rule — the mongo and mssql asserts both
  // stand aside for it, and an engine that did not would refuse clusters the
  // others accept.
  it("stands aside for the deployment-wide escape hatch", () => {
    allowInsecure.mockReturnValue(true);
    expect(() => assertPgTlsEnforced("postgresql://u@h/db?sslmode=disable")).not.toThrow();
  });

  it("throws InsecureConnectionError, which is what the dial guard catches", () => {
    expect(() => assertPgTlsEnforced("postgresql://u@h/db?sslmode=disable")).toThrow(
      InsecureConnectionError,
    );
  });

  // No representable rung on this driver: verify-ca demands a CA file a
  // connection string cannot carry. Refused rather than silently widened to the
  // certificate concession.
  it("refuses the hostname box on its own and names what to tick", () => {
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=verify-full",
        boxes({ allowInvalidHostnames: true }),
      ),
    ).toThrow(/invalid-certificates/);
  });

  // Measured on pg 8.22.0: the driver aliases a bare require to verify-full, so
  // it concedes nothing and refusing it would refuse a safe string.
  it("accepts a bare require but not one carrying the compat flag", () => {
    expect(() => assertPgTlsEnforced("postgresql://u@h/db?sslmode=require")).not.toThrow();
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=require&uselibpqcompat=true"),
    ).toThrow(/refusing to connect/);
  });

  // Unparseable is not a TLS verdict — isPgConnString refuses it first, and this
  // must not become a second, differently-worded refusal for the same string.
  it("says nothing about a string it cannot parse", () => {
    expect(() => assertPgTlsEnforced("not a connection string")).not.toThrow();
  });
});

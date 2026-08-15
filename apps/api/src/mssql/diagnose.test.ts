import { describe, expect, it } from "vitest";
import { evaluateMssqlPrivileges, type MssqlDatabaseGrants } from "./diagnose";

function db(overrides: Partial<MssqlDatabaseGrants> = {}): MssqlDatabaseGrants {
  return { viewState: true, alterEverySchema: true, alterAnyUser: false, ...overrides };
}

const SERVER_ONLY = new Set(["VIEW SERVER STATE"]);
const ADMIN = new Set(["VIEW SERVER STATE", "ALTER ANY LOGIN", "CONTROL SERVER"]);

describe("evaluateMssqlPrivileges", () => {
  it("grants everything for a sysadmin-shaped login", () => {
    const checks = evaluateMssqlPrivileges(
      ADMIN,
      new Map([
        ["app", db({ alterAnyUser: true })],
        ["reporting", db({ alterAnyUser: true })],
      ]),
    );
    expect(checks.every((check) => check.granted)).toBe(true);
  });

  it("read-only login: CORE granted, APPLY missing", () => {
    const checks = evaluateMssqlPrivileges(
      SERVER_ONLY,
      new Map([["app", db({ alterEverySchema: false })]]),
    );
    expect(checks.find((check) => check.key === "viewDatabaseState")?.granted).toBe(true);
    expect(checks.find((check) => check.key === "alterOnDatabase")?.granted).toBe(false);
  });

  it("a db-scoped grant must hold on EVERY user database", () => {
    const checks = evaluateMssqlPrivileges(
      SERVER_ONLY,
      new Map([
        ["app", db()],
        ["legacy", db({ viewState: false })],
      ]),
    );
    expect(checks.find((check) => check.key === "viewDatabaseState")?.granted).toBe(false);
  });

  it("no visible user databases grants nothing db-scoped", () => {
    const checks = evaluateMssqlPrivileges(SERVER_ONLY, new Map());
    expect(checks.find((check) => check.key === "viewDatabaseState")?.granted).toBe(false);
  });

  // #203. The three ways provisioning fails, and the middle one is the reason
  // there are three: a login holding ALTER ANY LOGIN creates the login happily
  // and then cannot grant it VIEW SERVER STATE (Msg 4613, verified on 2022).
  it("reports the provisioning gaps separately from the engine's own", () => {
    const checks = evaluateMssqlPrivileges(
      new Set(["VIEW SERVER STATE", "ALTER ANY LOGIN"]),
      new Map([["app", db({ alterAnyUser: true })]]),
    );
    expect(checks.find((check) => check.key === "alterAnyLogin")?.granted).toBe(true);
    expect(checks.find((check) => check.key === "controlServer")?.granted).toBe(false);
    expect(checks.find((check) => check.key === "alterAnyUser")?.granted).toBe(true);
    // The engine's own checks are untouched by any of it.
    expect(checks.find((check) => check.key === "viewServerState")?.granted).toBe(true);
  });

  it("needs ALTER ANY USER in every database, not just the first", () => {
    const checks = evaluateMssqlPrivileges(
      ADMIN,
      new Map([
        ["app", db({ alterAnyUser: true })],
        ["legacy", db({ alterAnyUser: false })],
      ]),
    );
    expect(checks.find((check) => check.key === "alterAnyUser")?.granted).toBe(false);
    // …and a database the login cannot enter at all fails the engine's checks
    // too, which is exactly what a database created after provisioning looks
    // like: named as missing rather than silently skipped.
    const newDatabase = evaluateMssqlPrivileges(
      ADMIN,
      new Map([
        ["app", db()],
        ["created_later", { viewState: false, alterEverySchema: false, alterAnyUser: false }],
      ]),
    );
    expect(newDatabase.find((check) => check.key === "viewDatabaseState")?.granted).toBe(false);
    expect(newDatabase.find((check) => check.key === "alterOnDatabase")?.granted).toBe(false);
  });
});

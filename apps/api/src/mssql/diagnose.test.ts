import { describe, expect, it } from "vitest";
import { evaluateMssqlPrivileges } from "./diagnose";

const db = (viewState: boolean, alter: boolean) => ({ viewState, alter });

describe("evaluateMssqlPrivileges", () => {
  it("grants everything for a sysadmin-shaped login", () => {
    const checks = evaluateMssqlPrivileges(
      new Set(["VIEW SERVER STATE"]),
      new Map([
        ["app", db(true, true)],
        ["reporting", db(true, true)],
      ]),
    );
    expect(checks.every((check) => check.granted)).toBe(true);
  });

  it("read-only login: CORE granted, APPLY missing", () => {
    const checks = evaluateMssqlPrivileges(
      new Set(["VIEW SERVER STATE"]),
      new Map([["app", db(true, false)]]),
    );
    expect(checks.find((check) => check.key === "viewDatabaseState")?.granted).toBe(true);
    expect(checks.find((check) => check.key === "alterOnDatabase")?.granted).toBe(false);
  });

  it("a db-scoped grant must hold on EVERY user database", () => {
    const checks = evaluateMssqlPrivileges(
      new Set(["VIEW SERVER STATE"]),
      new Map([
        ["app", db(true, true)],
        ["legacy", db(false, true)],
      ]),
    );
    expect(checks.find((check) => check.key === "viewDatabaseState")?.granted).toBe(false);
  });

  it("no visible user databases grants nothing db-scoped", () => {
    const checks = evaluateMssqlPrivileges(new Set(["VIEW SERVER STATE"]), new Map());
    expect(checks.find((check) => check.key === "viewDatabaseState")?.granted).toBe(false);
  });
});

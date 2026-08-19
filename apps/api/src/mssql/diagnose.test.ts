import { describe, expect, it } from "vitest";
import { evaluateMssqlPrivileges, type MssqlDatabaseGrants, queryStoreCheck } from "./diagnose";

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

// #246. The row used to end in "ALTER DATABASE … SET QUERY_STORE = ON" and leave
// the reader to expand the ellipsis once per database, having first worked out
// which databases were missing it. These are the statements they now paste into a
// query window on production, so the wording is pinned rather than trusted.
describe("queryStoreCheck", () => {
  it("hands over one statement per database that is missing it", () => {
    const check = queryStoreCheck(["appdb", "reporting"]);
    expect(check.granted).toBe(false);
    expect(check.command).toBe(
      "ALTER DATABASE [appdb] SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE, MAX_STORAGE_SIZE_MB = 1000);\n" +
        "ALTER DATABASE [reporting] SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE, MAX_STORAGE_SIZE_MB = 1000);",
    );
    // And says which ones, because that was always the reader's next question.
    expect(check.enables).toContain("off on appdb, reporting");
  });

  // MAX_STORAGE_SIZE_MB is not decoration. Measured on real instances: a new 2017
  // database gets 100 MB with QUERY_CAPTURE_MODE = ALL, a new 2022 database gets
  // 1000 with AUTO. A bare enable on the older generation captures everything into
  // 100 MB, and a full store flips to READ_ONLY and stops capturing silently.
  it("carries the storage budget newer versions default to", () => {
    expect(queryStoreCheck(["appdb"]).command).toContain("MAX_STORAGE_SIZE_MB = 1000");
  });

  // Deliberately absent: the integration suite sets ALL so its own one-off seeded
  // queries are captured deterministically. A production workload runs repeatedly
  // and AUTO captures it, so this must not push the expensive mode onto a customer.
  it("does not set the capture mode", () => {
    expect(queryStoreCheck(["appdb"]).command).not.toContain("QUERY_CAPTURE_MODE");
  });

  it("escapes a database name that would break out of the brackets", () => {
    expect(queryStoreCheck(["od]d"]).command).toContain("ALTER DATABASE [od]]d] SET QUERY_STORE");
  });

  it("is granted with nothing to run when every database has it", () => {
    const check = queryStoreCheck([]);
    expect(check.granted).toBe(true);
    expect(check.command).toBeNull();
  });

  // The third state, and the one a boolean would have got wrong: nothing was asked,
  // so this must not draw a tick beside Query Store on a server that never answered.
  it("is not granted, with nothing to run, when the cluster was never asked", () => {
    const check = queryStoreCheck(null);
    expect(check.granted).toBe(false);
    expect(check.command).toBeNull();
    expect(check.enables).toContain("ALTER DATABASE …");
  });
});

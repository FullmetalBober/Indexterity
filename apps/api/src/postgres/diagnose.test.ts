import { describe, expect, it } from "vitest";
import { surplusPrivileges, type WritableSchema } from "./diagnose";

// The role Indexterity provisions on this engine: pg_monitor, CONNECT, USAGE —
// and none of the attributes below.
const SCOPED = {
  whoami: "idx_a91f",
  is_super: false,
  can_createrole: false,
  can_createdb: false,
};

function writable(over: Partial<WritableSchema> = {}): WritableSchema {
  return { database: "app", schema: "public", tables: 3, ...over };
}

// #313. What this role holds that the engine never uses — and, as importantly,
// what is NOT surplus on this engine.
describe("surplusPrivileges", () => {
  it("finds nothing on the scoped role", () => {
    // The reassuring case is empty rather than four ticked rows. A surplus list is
    // a list of findings, and "you are not a superuser" is reassurance dressed as
    // one — the screen says "nothing" in words instead (#289).
    expect(surplusPrivileges(SCOPED, [])).toEqual([]);
  });

  it("reports SUPERUSER and CREATEROLE separately, each with the statement that applies", () => {
    const checks = surplusPrivileges({ ...SCOPED, is_super: true, can_createrole: true }, []);
    // Both rows, even though superuser implies createrole: NOCREATEROLE on a
    // superuser changes nothing, so only NOSUPERUSER actually removes anything —
    // and the reader needs both statements to end up with neither attribute.
    expect(checks.find((check) => check.key === "surplus_superuser")?.command).toBe(
      'ALTER ROLE "idx_a91f" NOSUPERUSER;',
    );
    expect(checks.find((check) => check.key === "surplus_createrole")?.command).toBe(
      'ALTER ROLE "idx_a91f" NOCREATEROLE;',
    );
  });

  it("reports CREATEDB", () => {
    const checks = surplusPrivileges({ ...SCOPED, can_createdb: true }, []);
    expect(checks.map((check) => check.key)).toEqual(["surplus_createdb"]);
    expect(checks[0]?.command).toBe('ALTER ROLE "idx_a91f" NOCREATEDB;');
  });

  it("revokes writes per schema, under the psql connect that makes each runnable", () => {
    const checks = surplusPrivileges(SCOPED, [
      writable(),
      writable({ schema: "billing", tables: 1 }),
      writable({ database: "reporting", tables: 8 }),
    ]);
    const write = checks.find((check) => check.key === "surplus_write");
    expect(write?.enables).toContain("12 tables");
    expect(write?.enables).toContain("app.public, app.billing, reporting.public");
    // Grouped by database and prefixed with the psql meta-command, because no SQL
    // statement can cross a database boundary here — a single block without it
    // would silently revoke twice in the first database.
    expect(write?.command).toBe(
      '\\connect "app"\n' +
        'REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" FROM "idx_a91f";\n' +
        'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE INSERT, UPDATE, DELETE ON TABLES FROM "idx_a91f";\n' +
        'REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "billing" FROM "idx_a91f";\n' +
        'ALTER DEFAULT PRIVILEGES IN SCHEMA "billing" REVOKE INSERT, UPDATE, DELETE ON TABLES FROM "idx_a91f";\n' +
        '\\connect "reporting"\n' +
        'REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" FROM "idx_a91f";\n' +
        'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE INSERT, UPDATE, DELETE ON TABLES FROM "idx_a91f";',
    );
  });

  it("bounds the schema list in the sentence and keeps every one in the statements", () => {
    const many = ["public", "billing", "audit", "staging", "archive"].map((schema) =>
      writable({ schema, tables: 1 }),
    );
    const write = surplusPrivileges(SCOPED, many).find((check) => check.key === "surplus_write");
    // A hundred-schema server must not push the rest of the sentence off the
    // card; the statements below it name all five either way.
    expect(write?.enables).toContain("and 2 more");
    for (const schema of ["public", "billing", "audit", "staging", "archive"]) {
      expect(write?.command).toContain(`IN SCHEMA "${schema}"`);
    }
  });

  it("does not call read access surplus", () => {
    // The engine-level tension the issue flags: applying here requires OWNERSHIP,
    // no grantable index privilege exists, and an owner can always SELECT. So
    // read access is a consequence of a requirement, and a row telling somebody
    // to revoke it would be telling them to break their own APPLY check.
    const checks = surplusPrivileges({ ...SCOPED, is_super: true }, [writable()]);
    for (const check of checks) {
      expect(check.label).not.toMatch(/SELECT/i);
      expect(check.command ?? "").not.toMatch(/REVOKE SELECT/i);
    }
  });
});

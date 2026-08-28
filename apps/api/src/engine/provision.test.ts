import { describe, expect, it } from "vitest";
import { revokeCommandFor, SCOPED_USERNAME } from "./provision";
import { supportedEngines } from "./registry";

// The scoped user is the one thing Indexterity leaves behind on a customer's
// server, and this string is the entire remedy. It used to be MongoDB's
// `dropUser` for all three engines (#338) — unusable on two of them, and silently
// so, because nothing errors and the screen just prints something that cannot
// work.
describe("revokeCommandFor", () => {
  const databases = ["appdb", "reporting"];

  it("has nothing to revoke when the customer pasted their own string", () => {
    expect(revokeCommandFor("MONGODB", null, null)).toBeNull();
    expect(revokeCommandFor("POSTGRESQL", null, databases)).toBeNull();
  });

  it("gives MongoDB the admin-database dropUser and no per-database statements", () => {
    const command = revokeCommandFor("MONGODB", SCOPED_USERNAME, []);
    expect(command).toBe(`db.getSiblingDB("admin").dropUser("${SCOPED_USERNAME}")`);
  });

  it("ignores a database list on MongoDB, whose user is server-scoped", () => {
    expect(revokeCommandFor("MONGODB", SCOPED_USERNAME, databases)).toBe(
      revokeCommandFor("MONGODB", SCOPED_USERNAME, []),
    );
  });

  // The two-step forms are required, not belt-and-braces: both engines refuse to
  // drop the principal while the per-database grants provisioning created still
  // point at it.
  it("visits every provisioned database before dropping the PostgreSQL role", () => {
    const command = revokeCommandFor("POSTGRESQL", SCOPED_USERNAME, databases) ?? "";
    for (const database of databases) {
      expect(command).toContain(`\\c "${database}"`);
    }
    expect(command).toContain(`DROP OWNED BY "${SCOPED_USERNAME}";`);
    expect(command).toContain(`DROP ROLE "${SCOPED_USERNAME}";`);
    expect(command.indexOf("DROP OWNED BY")).toBeLessThan(command.indexOf("DROP ROLE"));
  });

  it("drops every SQL Server database user before the login", () => {
    const command = revokeCommandFor("MSSQL", SCOPED_USERNAME, databases) ?? "";
    for (const database of databases) {
      expect(command).toContain(database);
    }
    expect(command).toContain(`DROP USER IF EXISTS [${SCOPED_USERNAME}]`);
    expect(command).toContain(`DROP LOGIN [${SCOPED_USERNAME}];`);
    expect(command.indexOf("DROP USER")).toBeLessThan(command.indexOf("DROP LOGIN"));
  });

  // A row provisioned before provisioned_databases existed carries null. MongoDB
  // is unaffected; the other two degrade to a bare drop their server refuses,
  // which is a visible failure rather than a statement that quietly does the
  // wrong thing.
  it("still answers for a row that predates the stored database list", () => {
    expect(revokeCommandFor("MONGODB", SCOPED_USERNAME, null)).toContain("dropUser");
    expect(revokeCommandFor("POSTGRESQL", SCOPED_USERNAME, null)).toBe(
      `DROP ROLE "${SCOPED_USERNAME}";`,
    );
    expect(revokeCommandFor("MSSQL", SCOPED_USERNAME, null)).toBe(
      `DROP LOGIN [${SCOPED_USERNAME}];`,
    );
  });

  // The guard against a fourth adapter landing without one: the port declares
  // revokeStatements, so this fails at the registry rather than on a screen.
  it("every supported engine answers with something engine-shaped", () => {
    for (const engine of supportedEngines()) {
      const command = revokeCommandFor(engine, SCOPED_USERNAME, databases) ?? "";
      expect(command).toContain(SCOPED_USERNAME);
    }
    expect(
      new Set(supportedEngines().map((e) => revokeCommandFor(e, SCOPED_USERNAME, databases))),
    ).toHaveProperty("size", supportedEngines().length);
  });
});

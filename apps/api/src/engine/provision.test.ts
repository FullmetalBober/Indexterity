import { describe, expect, it } from "vitest";
import {
  currentPrivilegesRevision,
  heldPrivilegesRevision,
  newPrivilegesFor,
  revokeCommandFor,
  SCOPED_USERNAME,
} from "./provision";
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

// What a release added since a cluster's credentials were set up (#599).
describe("newPrivilegesFor", () => {
  // Checked, and found missing — the one state a notice is for.
  const row = (overrides: Partial<Parameters<typeof newPrivilegesFor>[0]> = {}) => ({
    engine: "MONGODB" as const,
    credentialPosture: "PROVISIONED" as const,
    provisionedUsername: SCOPED_USERNAME,
    privilegesRevision: 0,
    privilegesCheckedRevision: currentPrivilegesRevision("MONGODB"),
    ...overrides,
  });

  // Unknown is not missing: atlasAdmin carries enableProfiler, and a cluster on it
  // must not be told to grant what it holds just because nobody has asked yet.
  it("says nothing about a change nobody has checked", () => {
    expect(newPrivilegesFor(row({ privilegesCheckedRevision: 0 }))).toEqual({
      pending: [],
      command: null,
      canUpgrade: false,
    });
  });

  it("lists what changed, with the statement and the upgrade, on a role of ours", () => {
    const view = newPrivilegesFor(row());
    expect(view.pending.map((change) => change.key)).toEqual(["enableProfiler"]);
    expect(view.pending[0]?.release).toBe("0.29.0");
    expect(view.command).toContain('grantPrivilegesToRole("indexterityEngine"');
    expect(view.canUpgrade).toBe(true);
  });

  // #246: a role made by hand has a name we do not know, so no template with a
  // blank in it — the change is listed and the guide does the rest.
  it("lists what changed with no statement on a role made by hand", () => {
    const view = newPrivilegesFor(row({ credentialPosture: "SCOPED", provisionedUsername: null }));
    expect(view.pending).toHaveLength(1);
    expect(view.command).toBeNull();
    expect(view.canUpgrade).toBe(false);
  });

  // Admin credentials hold every action there is.
  it("has nothing new for admin credentials", () => {
    expect(
      newPrivilegesFor(row({ credentialPosture: "ADMIN", provisionedUsername: null })),
    ).toEqual({
      pending: [],
      command: null,
      canUpgrade: false,
    });
  });

  it("has nothing new once the cluster is current", () => {
    expect(
      newPrivilegesFor(row({ privilegesRevision: currentPrivilegesRevision("MONGODB") })),
    ).toEqual({
      pending: [],
      command: null,
      canUpgrade: false,
    });
  });

  // An engine whose role never changed tells nobody anything.
  it("has nothing new on an engine whose role never changed", () => {
    expect(newPrivilegesFor(row({ engine: "POSTGRESQL" })).pending).toEqual([]);
    expect(currentPrivilegesRevision("MSSQL")).toBe(0);
  });
});

describe("heldPrivilegesRevision", () => {
  it("is as far as the diagnosis shows every change granted", () => {
    expect(heldPrivilegesRevision("MONGODB", [{ key: "enableProfiler", granted: true }])).toBe(1);
    expect(heldPrivilegesRevision("MONGODB", [{ key: "enableProfiler", granted: false }])).toBe(0);
    // Not reported at all is not granted.
    expect(heldPrivilegesRevision("MONGODB", [])).toBe(0);
  });
});

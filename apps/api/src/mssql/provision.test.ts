import { describe, expect, it } from "vitest";
import { withMssqlCredentials } from "./conn-string";
import { dropLoginStatements, mssqlConnStringUsername } from "./provision";

// Provisioning itself needs a server and is proven in the integration suite;
// what is pinned here is the string handling around it, which is where a
// credential can quietly go missing.
describe("withMssqlCredentials", () => {
  it("replaces the credentials and keeps everything else about a URL string", () => {
    const out = withMssqlCredentials(
      "mssql://sa:admin%40pass@db.internal:14330/shop?encrypt=true",
      "idx_0123456789ab",
      "S3cr3t#pass",
    );
    expect(mssqlConnStringUsername(out)).toBe("idx_0123456789ab");
    expect(out).toContain("db.internal:14330");
    expect(out).toContain("encrypt=true");
    // The admin password must not survive anywhere in the string we store.
    expect(out).not.toContain("admin%40pass");
    expect(out).not.toContain("admin@pass");
  });

  it("round-trips a password through the URL form", () => {
    const out = withMssqlCredentials("mssql://sa:pw@host/db", "idx_a", "p@ss:w/rd?&=");
    const { password } = { password: new URL(out).password };
    expect(decodeURIComponent(password)).toBe("p@ss:w/rd?&=");
  });

  it("keeps an ADO string ADO, braced so ; and = survive", () => {
    const out = withMssqlCredentials(
      "Server=tcp:db,1433;Database=shop;User Id=sa;Password=old;Encrypt=true",
      "idx_b",
      "p;w=d",
    );
    expect(out).toContain("Server=tcp:db,1433");
    expect(out).toContain("Encrypt=true");
    expect(out).not.toContain("Password=old");
    expect(mssqlConnStringUsername(out)).toBe("idx_b");
  });

  it("leaves a string it cannot parse alone", () => {
    expect(withMssqlCredentials("nonsense", "idx_c", "pw")).toBe("nonsense");
  });
});

describe("mssqlConnStringUsername", () => {
  it("reads the login a string authenticates as, in both forms", () => {
    expect(mssqlConnStringUsername("mssql://idx_abc:pw@host/db")).toBe("idx_abc");
    expect(mssqlConnStringUsername("Server=host;User Id=idx_abc;Password=p")).toBe("idx_abc");
  });

  it("is null when there is no login to read", () => {
    expect(mssqlConnStringUsername("mssql://host/db")).toBeNull();
    expect(mssqlConnStringUsername("nonsense")).toBeNull();
  });
});

describe("dropLoginStatements", () => {
  // The users go first, in every database provisioning created one in: SQL
  // Server refuses to drop a login while any database user still maps to it, so
  // the order is the difference between a script that works and one that stops
  // half way with the login still there.
  it("drops each database's user before the login itself", () => {
    const lines = dropLoginStatements("indexterity", ["shop", "billing"]).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[shop]");
    expect(lines[0]).toContain("DROP USER IF EXISTS [indexterity]");
    expect(lines[1]).toContain("[billing]");
    expect(lines[2]).toBe("DROP LOGIN [indexterity];");
  });

  it("is just the login when the instance has no databases to clear", () => {
    expect(dropLoginStatements("indexterity", [])).toBe("DROP LOGIN [indexterity];");
  });
});

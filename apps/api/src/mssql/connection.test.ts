import { describe, expect, it } from "vitest";
import { MssqlConnection } from "./connection";

// The real class with only its query boundary replaced. Unlike the other two
// adapters, SQL Server's whole rule is IN the statement — the server filters and
// hands back the answer — so what a unit test can hold is the statement itself,
// which is the only place the four names live.
class Fake extends MssqlConnection {
  readonly statements: string[] = [];

  constructor(private readonly rows: readonly { name: string }[]) {
    super("mssql://sa:p@h:1433?trustservercertificate=true");
  }

  override async query<T>(text: string): Promise<T[]> {
    this.statements.push(text);
    return this.rows as unknown as T[];
  }
}

describe("listDatabaseNames", () => {
  // Excluded by name, which is the rule all three adapters follow (#347). `model`
  // and `msdb` go even though a real installation can be found with tables in
  // them — they are SQL Server's own working state, and application tables in one
  // are an anti-pattern rather than a shape to support. PostgreSQL's `postgres` is
  // the opposite case and is treated as one: not a system database at all.
  it("excludes the four the engine owns, and nothing else", async () => {
    const conn = new Fake([{ name: "app" }]);
    await conn.listDatabaseNames();
    expect(conn.statements[0]).toMatch(/name NOT IN \('master', 'tempdb', 'model', 'msdb'\)/);
  });

  // On top of the names: an OFFLINE or RESTORING database cannot be listed into,
  // so it is not a database this product can observe.
  it("asks for online databases only", async () => {
    const conn = new Fake([{ name: "app" }]);
    await conn.listDatabaseNames();
    expect(conn.statements[0]).toMatch(/state = 0/);
  });

  // A one-application instance reports one name, which is what keeps the observe
  // checkboxes off the screen — MIN_DATABASES_TO_CHOOSE is 2, and this is the
  // count the other two adapters had to be made to agree with.
  it("reports what the server answered", async () => {
    const conn = new Fake([{ name: "app" }]);
    expect(await conn.listDatabaseNames()).toEqual(["app"]);
  });
});

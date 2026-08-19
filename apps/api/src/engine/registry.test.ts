import { engineFromScheme } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { detectEngine, supportedEngineOptions, supportedEngines } from "./registry";

// The pair that would otherwise drift silently (#239).
//
// The dashboard cannot ship either connection-string parser, so it reads the
// SCHEME to draw a badge and to decide whether to offer the engine override
// (`engineFromScheme` in @repo/contracts). The api asks the adapters, which parse
// the whole string and are what actually decides. Two answers to one question, in
// two packages, and nothing but this file holds them together: a scheme added to
// an adapter and not to the hint shows the wrong engine on the connect form for a
// release, and the failure is cosmetic enough that nobody files it.
//
// Only agreement on strings the ADAPTERS claim is asserted. The reverse is not a
// rule and must not become one: the hint is allowed to be more permissive —
// `mssql://` with nothing after it looks like SQL Server and is not a valid
// string, and the reader who typed it should see "SQL Server" and then a refusal
// naming the form, not "unrecognised" and an override they do not need.
const CLAIMED = [
  "mongodb://user:pass@host:27017",
  "mongodb://user:pass@a:27017,b:27017/?replicaSet=rs0",
  "mongodb+srv://user:pass@cluster.example.mongodb.net/?retryWrites=true",
  "mssql://sa:pass@host:1433",
  "sqlserver://sa:pass@host:1433/db",
  "Server=host,1433;Database=shop;User Id=sa;Password=pass;Encrypt=true",
  "Data Source=host;Initial Catalog=shop;User Id=sa;Password=pass",
  "server=host;user id=sa;password=pass",
];

describe("the engine hint the dashboard draws", () => {
  it.each(CLAIMED)("agrees with the adapters on %s", (value) => {
    const decided = detectEngine(value);
    // If no adapter claims it the corpus is wrong, not the hint — this list is
    // supposed to be strings the product accepts.
    expect(decided, "no adapter claims this string").not.toBeNull();
    expect(engineFromScheme(value)).toBe(decided);
  });

  // What the override exists for: neither side recognises it, so the form asks
  // rather than guessing, and the api's fallback would otherwise dial it as
  // mongo and refuse with the wrong hint.
  it.each(["postgres://user:pass@host:5432/db", "host:1433", "", "   ", "not a connection string"])(
    "claims nothing for %s, which is what makes the override appear",
    (value) => {
      expect(engineFromScheme(value)).toBeNull();
      expect(detectEngine(value)).toBeNull();
    },
  );

  // The one place the two deliberately disagree, and the disagreement is the
  // better product: the mongo driver's own parser is case-SENSITIVE on the
  // scheme — `new ConnectionString("MongoDB://…")` throws "Invalid scheme,
  // expected connection string to start with mongodb://" — so no adapter claims
  // an upper-cased one and the api refuses it. The hint claims it anyway, which
  // means the reader who typed `MongoDB://` sees the MongoDB badge and then a
  // refusal quoting the exact form to use. Were the hint case-sensitive too they
  // would instead be offered the engine override, and picking MongoDB from it
  // lands on the same refusal — a choice that looks like the fix and is not.
  it("claims an upper-cased mongo scheme the driver's parser refuses", () => {
    expect(engineFromScheme("MongoDB://user:pass@host:27017")).toBe("MONGODB");
    expect(detectEngine("MongoDB://user:pass@host:27017")).toBeNull();
  });

  // A mongo string may legitimately carry `server=` inside its query, and the ADO
  // rule is anchored to the first key precisely so that cannot flip the badge to
  // SQL Server mid-type.
  it("does not let a query parameter rename the engine", () => {
    const value = "mongodb://user:pass@host:27017/?appName=server=1";
    expect(engineFromScheme(value)).toBe("MONGODB");
    expect(detectEngine(value)).toBe("MONGODB");
  });
});

describe("supportedEngineOptions", () => {
  // One row per engine with an adapter, and the hint is the adapter's own — the
  // sentence the connect form shows before a paste has to be the sentence the
  // refusal quotes after one, or the two describe different products.
  it("carries every supported engine with its own hint", () => {
    const options = supportedEngineOptions();
    expect(options.map((option) => option.engine)).toEqual(supportedEngines());
    for (const option of options) expect(option.connStringHint.length).toBeGreaterThan(0);
  });

  // The planned slot stays out of the list rather than appearing as something a
  // reader could choose and then be refused (#35).
  it("omits an engine with no adapter", () => {
    expect(supportedEngineOptions().map((option) => option.engine)).not.toContain("POSTGRESQL");
  });
});

import { canHideIndexes, engineFromScheme } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { adapterFor, detectEngine, supportedEngineOptions, supportedEngines } from "./registry";

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
  //
  // `postgres://` used to be in this list and is not any more — its adapter
  // shipped with #35, so both sides claim it now, which is the case below.
  it.each(["host:1433", "", "   ", "not a connection string"])(
    "claims nothing for %s, which is what makes the override appear",
    (value) => {
      expect(engineFromScheme(value)).toBeNull();
      expect(detectEngine(value)).toBeNull();
    },
  );

  // Both spellings of the URI form, and libpq's keyword form, which has no
  // scheme at all — the same shape as SQL Server's ADO string and anchored the
  // same way so the two cannot claim each other.
  it.each([
    "postgresql://user:pass@host:5432/db",
    "postgres://user:pass@host:5432/db",
    "postgresql://u:p@primary:5432,standby:5433/app",
    "host=db.corp port=5432 dbname=app user=u",
  ])("agrees on %s now that the adapter has shipped", (value) => {
    expect(engineFromScheme(value)).toBe("POSTGRESQL");
    expect(detectEngine(value)).toBe("POSTGRESQL");
  });

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

  // All three engines ship now (#35). The property that mattered when one did
  // not still holds and is worth keeping: the list is derived from the adapters,
  // so an engine without one cannot appear as something a reader could choose and
  // then be refused.
  it("carries all three shipped engines", () => {
    expect(
      supportedEngineOptions()
        .map((option) => option.engine)
        .sort(),
    ).toEqual(["MONGODB", "MSSQL", "POSTGRESQL"]);
  });

  it("derives the list from the adapters rather than a written-out set", () => {
    expect(supportedEngineOptions().map((option) => option.engine)).toEqual(supportedEngines());
  });
});

// The second pair in this file that would drift silently, for the same reason as
// the first (#303). The dashboard says "hide, drop and build" on the go-live
// dialog and promises to restore hidden indexes on disconnect, and it cannot
// import an adapter to find out whether either is true — so @repo/contracts
// carries a table and this holds it to the adapters themselves. An engine shipped
// without a hide would otherwise keep promising one for a release.
describe("canHideIndexes", () => {
  it("agrees with every supported adapter's own capability", () => {
    for (const engine of supportedEngines()) {
      expect(canHideIndexes(engine)).toBe(adapterFor(engine).capabilities.hideIndexes);
    }
  });

  // Asserted rather than left implied: this is the value the whole no-hide path
  // through apply.ts and finalize.ts exists for, and the one the PostgreSQL
  // adapter will be built against (#35). Measured on 17.11 and 18.6 — clearing
  // `pg_index.indisvalid` is the only mechanism and it needs superuser.
  it("says PostgreSQL cannot hide, before its adapter exists", () => {
    expect(canHideIndexes("POSTGRESQL")).toBe(false);
  });
});

// The recommender's `{field: literal}` filter is MongoDB's partialFilterExpression
// as it stands. The SQL engines build a partial index only from the predicate
// their own collector read back (`{definition}`, `{sql}`), so a candidate derived
// from constants is one they cannot build — and proposing it anyway blocked a
// production SQL Server as an unsupported version (#452). Spelled out per engine
// rather than looped, so a fourth adapter has to say which it is.
describe("partialIndexFromConstants", () => {
  it("is MongoDB's alone until a SQL translation exists", () => {
    expect(adapterFor("MONGODB").capabilities.partialIndexFromConstants).toBe(true);
    expect(adapterFor("MSSQL").capabilities.partialIndexFromConstants).toBe(false);
    expect(adapterFor("POSTGRESQL").capabilities.partialIndexFromConstants).toBe(false);
  });
});

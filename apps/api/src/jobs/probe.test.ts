import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH, MSSQL_HEALTH } from "../analysis";
import { healthOptionsFor } from "./probe";

// Which reading of the counters a cluster gets. Worth a test rather than a
// branch nobody looks at: the ServerHealth shape is shared, so handing MSSQL
// mongo's thresholds does not fail — it silently never fires, which is exactly
// the state #205 opened with.
describe("healthOptionsFor", () => {
  it("gives SQL Server the thresholds derived from its own counters", () => {
    expect(healthOptionsFor("MSSQL")).toBe(MSSQL_HEALTH);
    // Pages per index search, not documents per key: the healthy floor is the
    // b-tree descent, so mongo's 100 would never be reached.
    expect(MSSQL_HEALTH.elevatedDocsPerKey).toBeLessThan(DEFAULT_HEALTH.elevatedDocsPerKey);
    // Workfiles are SPILLS, which is a rarer and worse event than an in-memory
    // sort, so the bar is lower rather than higher.
    expect(MSSQL_HEALTH.elevatedSorts).toBeLessThan(DEFAULT_HEALTH.elevatedSorts);
  });

  it("leaves every other engine on the mongod-derived defaults", () => {
    expect(healthOptionsFor("MONGODB")).toBe(DEFAULT_HEALTH);
    // PostgreSQL has no adapter yet (#35). Falling back rather than throwing is
    // the right default for a shape that is genuinely shared — and the day it
    // arrives, this test is where the third reading gets named.
    expect(healthOptionsFor("POSTGRESQL")).toBe(DEFAULT_HEALTH);
  });

  it("keeps the reader queue comparable across engines", () => {
    expect(MSSQL_HEALTH.criticalQueuedReaders).toBe(DEFAULT_HEALTH.criticalQueuedReaders);
  });
});

import { describe, expect, it } from "vitest";
import { PLAN_PARSE_CHUNK } from "./chunk";
import { deletePatternsFromPlans, retentionSecondsFrom } from "./delete-patterns";

// Cut down from real plans captured off a 2022 CU26, keeping the elements this
// reads: the statement type, the Compare with its CompareOp, the qualified
// ColumnReference, and the ScalarString that carries the cutoff expression.
function deletePlan(
  scalarString: string,
  options: { statementType?: string; column?: string; op?: string; table?: string } = {},
): string {
  const column = options.column ?? "created_at";
  const table = options.table ?? "events";
  return `<ShowPlanXML><BatchSequence><Batch><Statements>
    <StmtSimple StatementType="${options.statementType ?? "DELETE"}">
      <QueryPlan><RelOp><Update>
        <RelOp><IndexScan><Predicate>
          <ScalarOperator ScalarString="${scalarString}">
            <Compare CompareOp="${options.op ?? "LT"}">
              <ScalarOperator><Identifier>
                <ColumnReference Database="[shop]" Schema="[dbo]" Table="[${table}]" Column="${column}" />
              </Identifier></ScalarOperator>
              <ScalarOperator><Identifier>
                <ColumnReference Column="ConstExpr1004" />
              </Identifier></ScalarOperator>
            </Compare>
          </ScalarOperator>
        </Predicate></IndexScan></RelOp>
      </Update></RelOp></QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence></ShowPlanXML>`;
}

// The three dialects a real purge job is written in, all captured live.
const DATEADD = "[shop].[dbo].[events].[created_at]&lt;dateadd(day,(-90),sysutcdatetime())";
const PARAMETERISED = "[shop].[dbo].[events].[created_at]&lt;[@cutoff]";

describe("retentionSecondsFrom", () => {
  // Every unit the probe exercised, with the offsets it used.
  it.each([
    ["dateadd(second,(-1),sysutcdatetime())", 1],
    ["dateadd(minute,(-2),sysutcdatetime())", 120],
    ["dateadd(hour,(-3),sysutcdatetime())", 10_800],
    ["dateadd(day,(-90),sysutcdatetime())", 7_776_000],
    ["dateadd(week,(-5),sysutcdatetime())", 3_024_000],
  ])("reads %s", (text, seconds) => {
    expect(retentionSecondsFrom(text)).toBe(seconds);
  });

  it("has nothing to read from a parameterised cutoff", () => {
    expect(retentionSecondsFrom("[shop].[dbo].[events].[created_at]<[@cutoff]")).toBeNull();
  });

  // A positive offset is a cutoff in the FUTURE, which deletes the whole table.
  // Reporting that as a retention window would be a confident wrong number.
  it("refuses an offset that is not subtracting", () => {
    expect(retentionSecondsFrom("dateadd(day,(30),sysutcdatetime())")).toBeNull();
  });

  it("refuses a unit it does not know rather than guessing", () => {
    expect(retentionSecondsFrom("dateadd(nanosecond,(-5),sysutcdatetime())")).toBeNull();
  });
});

describe("deletePatternsFromPlans", () => {
  it("reads the column and the retention off a DATEADD purge", async () => {
    expect(
      await deletePatternsFromPlans(
        [{ planXml: deletePlan(DATEADD), execs: 5 }],
        "shop",
        "dbo.events",
      ),
    ).toEqual([{ field: "created_at", count: 5, medianRetentionSeconds: 7_776_000 }]);
  });

  // The dialect an ORM or a stored procedure produces, and probably the most
  // common one. The pattern is still real; only the number is missing.
  it("reports the pattern without a retention when the cutoff is a parameter", async () => {
    expect(
      await deletePatternsFromPlans(
        [{ planXml: deletePlan(PARAMETERISED), execs: 4 }],
        "shop",
        "dbo.events",
      ),
    ).toEqual([{ field: "created_at", count: 4, medianRetentionSeconds: null }]);
  });

  it("sums executions across the plans of one column", async () => {
    const patterns = await deletePatternsFromPlans(
      [
        { planXml: deletePlan(DATEADD), execs: 5 },
        { planXml: deletePlan(PARAMETERISED), execs: 4 },
      ],
      "shop",
      "dbo.events",
    );
    expect(patterns).toEqual([
      { field: "created_at", count: 9, medianRetentionSeconds: 7_776_000 },
    ]);
  });

  // `>` is a query for RECENT rows, not a purge, and calling it one would put
  // "you delete by age every night" on a table nobody prunes.
  it("ignores a comparison that is not older-than", async () => {
    expect(
      await deletePatternsFromPlans(
        [{ planXml: deletePlan(DATEADD, { op: "GT" }), execs: 5 }],
        "shop",
        "dbo.events",
      ),
    ).toEqual([]);
  });

  it("ignores a SELECT with the same predicate", async () => {
    expect(
      await deletePatternsFromPlans(
        [{ planXml: deletePlan(DATEADD, { statementType: "SELECT" }), execs: 5 }],
        "shop",
        "dbo.events",
      ),
    ).toEqual([]);
  });

  // Query Store records a query in the database it RAN in, not the one it read,
  // so a plan over another database's dbo.events must not be attributed here —
  // the same trap tableOf exists for in the workload pass.
  it("ignores a purge of another database's table of the same name", async () => {
    expect(
      await deletePatternsFromPlans(
        [{ planXml: deletePlan(DATEADD), execs: 5 }],
        "other",
        "dbo.events",
      ),
    ).toEqual([]);
  });

  it("ignores a purge of a different table in this database", async () => {
    expect(
      await deletePatternsFromPlans(
        [{ planXml: deletePlan(DATEADD), execs: 5 }],
        "shop",
        "dbo.orders",
      ),
    ).toEqual([]);
  });

  // Once a supporting index exists the predicate moves out of Compare and into
  // the seek's EndRange. Reading only the scan shape would make the pattern
  // vanish the moment somebody indexed it — which is precisely when the table
  // is big enough for the partition half of the advice to matter.
  it("reads the seek shape a supported purge plans as", async () => {
    const seek = `<ShowPlanXML><BatchSequence><Batch><Statements>
      <StmtSimple StatementType="DELETE"><QueryPlan><RelOp><Update><RelOp><IndexScan>
        <SeekPredicates><SeekPredicateNew><SeekKeys><EndRange ScanType="LT">
          <RangeColumns>
            <ColumnReference Database="[shop]" Schema="[dbo]" Table="[events]" Column="created_at" />
          </RangeColumns>
          <RangeExpressions>
            <ScalarOperator ScalarString="dateadd(day,(-200),sysutcdatetime())" />
          </RangeExpressions>
        </EndRange></SeekKeys></SeekPredicateNew></SeekPredicates>
      </IndexScan></RelOp></Update></RelOp></QueryPlan></StmtSimple>
    </Statements></Batch></BatchSequence></ShowPlanXML>`;
    expect(
      await deletePatternsFromPlans([{ planXml: seek, execs: 3 }], "shop", "dbo.events"),
    ).toEqual([{ field: "created_at", count: 3, medianRetentionSeconds: 17_280_000 }]);
  });

  it("says nothing about malformed XML rather than throwing mid-collect", async () => {
    expect(
      await deletePatternsFromPlans([{ planXml: "<not xml", execs: 5 }], "shop", "dbo.events"),
    ).toEqual([]);
  });

  // This pass parses up to MAX_PLANS_PER_DATABASE plans and must not hold the
  // event loop for all of them (#230) — the workload pass measured 1652 ms of
  // stall doing exactly that.
  //
  // The stall itself is measured over there, on the bigger corpus; what is
  // asserted here is the thing a revert would break, and it needs no wall
  // clock to see: a self-rescheduling setImmediate runs once per turn of the
  // loop, so it counts the turns the parse gave away. A synchronous body —
  // including an `async` one that never awaits — runs to completion before the
  // loop gets one, and counts zero.
  it("gives the event loop turns while it parses", async () => {
    const rows = Array.from({ length: PLAN_PARSE_CHUNK * 4 }, () => ({
      planXml: deletePlan(DATEADD),
      execs: 1,
    }));
    let turns = 0;
    let spinning = true;
    const spin = (): void => {
      if (!spinning) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    try {
      await deletePatternsFromPlans(rows, "shop", "dbo.events");
    } finally {
      spinning = false;
    }
    expect(turns).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { workloadOfPlan } from "./plan-facts";

// What suggest keeps per plan (#588): everything it reads off one plan's XML,
// from one parse, with the identifiers shared across plans.

const COLUMN = (table: string, column: string) =>
  `<ColumnReference Database="[shop]" Schema="[dbo]" Table="[${table}]" Column="${column}" />`;

const seek = (customer: number) => `<ShowPlanXML><StmtSimple StatementType="SELECT">
  <RelOp PhysicalOp="Index Seek"><IndexScan>
    <SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ">
      <RangeColumns>${COLUMN("orders", "customer_id")}</RangeColumns>
      <RangeExpressions><ScalarOperator><Const ConstValue="(${customer})" /></ScalarOperator></RangeExpressions>
    </Prefix></SeekKeys></SeekPredicateNew></SeekPredicates>
    <Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[ix_customer]" IndexKind="NonClustered" />
  </IndexScan></RelOp>
</StmtSimple></ShowPlanXML>`;

const purge = `<ShowPlanXML><StmtSimple StatementType="DELETE"><RelOp><Update><RelOp><IndexScan><Predicate>
  <ScalarOperator ScalarString="[shop].[dbo].[events].[created_at]&lt;dateadd(day,(-30),sysutcdatetime())">
    <Compare CompareOp="LT">
      <ScalarOperator><Identifier>${COLUMN("events", "created_at")}</Identifier></ScalarOperator>
      <ScalarOperator><Identifier><ColumnReference Column="ConstExpr1004" /></Identifier></ScalarOperator>
    </Compare>
  </ScalarOperator>
</Predicate></IndexScan></RelOp></Update></RelOp></StmtSimple></ShowPlanXML>`;

describe("workloadOfPlan", () => {
  it("reads a plan's shapes and its purges from the same XML", () => {
    expect(workloadOfPlan(seek(42), "shop").shapes).toEqual([
      expect.objectContaining({ table: "dbo.orders", equality: ["customer_id"] }),
    ]);
    expect(workloadOfPlan(purge, "shop").purges).toEqual([
      { table: "dbo.events", field: "created_at", retentionSeconds: 2_592_000 },
    ]);
    expect(workloadOfPlan(seek(42), "shop").purges).toEqual([]);
  });

  it("says nothing about XML it cannot parse", () => {
    expect(workloadOfPlan("<not xml", "shop")).toEqual({ shapes: [], missing: [], purges: [] });
  });

  // Thousands of plans name the same tables and columns, and each plan's copy
  // comes out of the parser as a fresh string. Kept per plan, those copies are
  // most of what the facts would cost — so they are one shared instance.
  it("shares the names and column lists of one plan with the next", () => {
    const first = workloadOfPlan(seek(7), "shop").shapes[0];
    const second = workloadOfPlan(seek(8), "shop").shapes[0];
    expect(second?.table).toBe(first?.table);
    expect(second?.equality).toBe(first?.equality);
    // What differs between them is the one thing that is the plan's own.
    expect(first?.constants).toEqual({ customer_id: 7 });
    expect(second?.constants).toEqual({ customer_id: 8 });
  });
});

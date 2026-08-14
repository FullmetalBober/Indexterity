import { describe, expect, it } from "vitest";
import { workloadKey } from "../engine/ports";
import { type PlanRow, parseConstValue, parseShowplanShapes, shapesFromPlans } from "./workload";

// Minimal but grammatically real showplan fragments — the element anatomy
// (Prefix/StartRange, Compare/CompareOp, OrderByColumn, MissingIndex) was
// captured from a live 2022 and these mirror it 1:1.
const COL = (column: string, table = "orders") =>
  `<ColumnReference Database="[probe]" Schema="[dbo]" Table="[${table}]" Column="${column}"></ColumnReference>`;

// Note the intermediate <SeekKeys> and the RangeExpressions beside Prefix —
// both are what the live server actually emits.
const SEEK_PLAN = `<ShowPlanXML><StmtSimple StatementType="SELECT"><RelOp PhysicalOp="Index Seek">
  <IndexScan Ordered="1" ScanDirection="FORWARD">
    <Object Database="[probe]" Schema="[dbo]" Table="[orders]" Index="[ix_cust_created]" IndexKind="NonClustered"></Object>
    <SeekPredicates><SeekPredicateNew><SeekKeys>
      <Prefix ScanType="EQ">
        <RangeColumns>${COL("customer_id")}</RangeColumns>
        <RangeExpressions><ScalarOperator ScalarString="(42)"><Const ConstValue="(42)"></Const></ScalarOperator></RangeExpressions>
      </Prefix>
      <StartRange ScanType="GT">
        <RangeColumns>${COL("created_at")}</RangeColumns>
        <RangeExpressions><ScalarOperator ScalarString="dateadd(day,(-30),sysdatetime())"><Identifier><ColumnReference Column="ConstExpr1003"></ColumnReference></Identifier></ScalarOperator></RangeExpressions>
      </StartRange>
    </SeekKeys></SeekPredicateNew></SeekPredicates>
  </IndexScan></RelOp></StmtSimple></ShowPlanXML>`;

const SCAN_SORT_PLAN = `<ShowPlanXML><StmtSimple StatementType="SELECT"><RelOp PhysicalOp="Sort">
  <TopSort Distinct="0" Rows="5"><OrderBy>
    <OrderByColumn Ascending="0">${COL("created_at")}</OrderByColumn>
  </OrderBy></TopSort></RelOp>
  <RelOp PhysicalOp="Clustered Index Scan"><IndexScan Ordered="0">
    <Object Database="[probe]" Schema="[dbo]" Table="[orders]" Index="[PK_orders]" IndexKind="Clustered"></Object>
    <Predicate><ScalarOperator><Logical Operation="AND">
      <ScalarOperator><Compare CompareOp="EQ">
        <ScalarOperator><Identifier>${COL("status")}</Identifier></ScalarOperator>
        <ScalarOperator><Const ConstValue="'open'"></Const></ScalarOperator>
      </Compare></ScalarOperator>
      <ScalarOperator><Compare CompareOp="EQ">
        <ScalarOperator><Identifier>${COL("region")}</Identifier></ScalarOperator>
        <ScalarOperator><Const ConstValue="'eu'"></Const></ScalarOperator>
      </Compare></ScalarOperator>
    </Logical></ScalarOperator></Predicate>
  </IndexScan></RelOp>
  <MissingIndexes><MissingIndexGroup Impact="33.6">
    <MissingIndex Database="[probe]" Schema="[dbo]" Table="[orders]">
      <ColumnGroup Usage="EQUALITY"><Column Name="[status]" ColumnId="3"></Column><Column Name="[region]" ColumnId="4"></Column></ColumnGroup>
      <ColumnGroup Usage="INCLUDE"><Column Name="[amount]" ColumnId="6"></Column></ColumnGroup>
    </MissingIndex>
  </MissingIndexGroup></MissingIndexes></StmtSimple></ShowPlanXML>`;

const NONCLUSTERED_RANGE_SCAN = `<ShowPlanXML><StmtSimple StatementType="SELECT"><RelOp PhysicalOp="Index Scan">
  <IndexScan Ordered="0">
    <Object Database="[probe]" Schema="[dbo]" Table="[orders]" Index="[ix_cust_created]" IndexKind="NonClustered"></Object>
    <Predicate><ScalarOperator><Compare CompareOp="GT">
      <ScalarOperator><Identifier>${COL("amount")}</Identifier></ScalarOperator>
      <ScalarOperator><Const ConstValue="(990.00)"></Const></ScalarOperator>
    </Compare></ScalarOperator></Predicate>
  </IndexScan></RelOp></StmtSimple></ShowPlanXML>`;

const JOIN_PLAN = `<ShowPlanXML><StmtSimple StatementType="SELECT">
  <RelOp PhysicalOp="Index Seek"><IndexScan Lookup="1">
    <Object Database="[probe]" Schema="[dbo]" Table="[orders]" Index="[PK_orders]" IndexKind="Clustered"></Object>
  </IndexScan></RelOp>
  <Compare CompareOp="EQ">
    <ScalarOperator><Identifier>${COL("customer_id")}</Identifier></ScalarOperator>
    <ScalarOperator><Identifier>${COL("id", "customers")}</Identifier></ScalarOperator>
  </Compare></StmtSimple></ShowPlanXML>`;

describe("parseShowplanShapes", () => {
  it("splits a seek into equality prefix and range, with the sought constant", () => {
    const { perTable } = parseShowplanShapes(SEEK_PLAN, "probe");
    const shape = perTable.get("dbo.orders");
    expect([...(shape?.equality ?? [])]).toEqual(["customer_id"]);
    expect([...(shape?.range ?? [])]).toEqual(["created_at"]);
    expect(shape?.collscan).toBe(false);
    expect(shape?.constants).toEqual({ customer_id: 42 });
    // The range's computed expression (ConstExpr…) must not leak in as a column.
    expect(shape?.range.has("ConstExpr1003")).toBe(false);
  });

  it("reads residual predicates, constants, the in-memory sort and the clustered collscan", () => {
    const { perTable, missing } = parseShowplanShapes(SCAN_SORT_PLAN, "probe");
    const shape = perTable.get("dbo.orders");
    expect([...(shape?.equality ?? [])].sort()).toEqual(["region", "status"]);
    expect(shape?.constants).toEqual({ status: "open", region: "eu" });
    expect(shape?.sort).toEqual([{ field: "created_at", direction: -1 }]);
    expect(shape?.sortedInMemory).toBe(true);
    expect(shape?.collscan).toBe(true);
    expect(missing).toEqual([{ table: "dbo.orders", equality: ["status", "region"], range: [] }]);
  });

  it("does not call a nonclustered full scan a collection scan", () => {
    const { perTable } = parseShowplanShapes(NONCLUSTERED_RANGE_SCAN, "probe");
    const shape = perTable.get("dbo.orders");
    expect(shape?.collscan).toBe(false);
    expect([...(shape?.range ?? [])]).toEqual(["amount"]);
  });

  it("skips key lookups and column-to-column join predicates", () => {
    const { perTable } = parseShowplanShapes(JOIN_PLAN, "probe");
    expect(perTable.get("dbo.orders")?.equality.size ?? 0).toBe(0);
    expect(perTable.get("dbo.customers")?.equality.size ?? 0).toBe(0);
  });

  it("attributes nothing from another database's objects", () => {
    // Query Store holds plans for queries RUN here that read elsewhere; a
    // same-named table in the other database must not swallow their shapes.
    const { perTable } = parseShowplanShapes(SEEK_PLAN, "otherdb");
    expect(perTable.size).toBe(0);
  });

  it("excludes DDL plans — CREATE INDEX's own scan+sort is not workload", () => {
    // Real DDL plans have StmtSimple with NO StatementType attribute at all.
    const ddl = SCAN_SORT_PLAN.replace(' StatementType="SELECT"', "");
    const { perTable, missing } = parseShowplanShapes(ddl, "probe");
    expect(perTable.size).toBe(0);
    expect(missing).toEqual([]);
  });

  it("contributes nothing on unparseable XML", () => {
    const { perTable, missing } = parseShowplanShapes("<not xml", "probe");
    expect(perTable.size).toBe(0);
    expect(missing).toEqual([]);
  });
});

describe("parseConstValue", () => {
  it("unwraps quotes, N-prefix and parens", () => {
    expect(parseConstValue("'open'")).toBe("open");
    expect(parseConstValue("N'it''s'")).toBe("it's");
    expect(parseConstValue("(990.00)")).toBe(990);
    expect(parseConstValue("(-3)")).toBe(-3);
    expect(parseConstValue("getdate()")).toBeNull();
  });
});

describe("shapesFromPlans", () => {
  const NOW = new Date("2026-08-14T12:00:00Z");
  const targets = [{ database: "probe", collection: "dbo.orders" }];
  const key = workloadKey("probe", "dbo.orders");
  const row = (planXml: string, execs: number, over: Partial<PlanRow> = {}): PlanRow => ({
    planXml,
    execs,
    totalIo: execs * 10,
    firstSeen: "2026-08-13T12:00:00Z",
    lastSeen: "2026-08-14T11:00:00Z",
    ...over,
  });

  it("merges Query-Store-fragmented literals into one shape", () => {
    // Same shape, different constants — two query_ids in the store.
    const variant = SCAN_SORT_PLAN.replaceAll("'open'", "'closed'").replaceAll("'eu'", "'us'");
    const shapes = shapesFromPlans(
      targets,
      "probe",
      [row(SCAN_SORT_PLAN, 3), row(variant, 2)],
      NOW,
    );
    const predicateShape = shapes
      .get(key)
      ?.find((shape) => shape.collscan && shape.equality.length === 2);
    expect(predicateShape?.count).toBe(5);
    expect(predicateShape?.docsExamined).toBe(50);
    // Disagreeing constants must not survive the merge — a partial-index
    // signal is "always compared against THIS value".
    expect(predicateShape?.constants).toBeUndefined();
    expect(predicateShape?.observedForHours).toBeCloseTo(24, 0);
  });

  it("folds the embedded missing-index suggestion in as its own shape", () => {
    const shapes = shapesFromPlans(targets, "probe", [row(SCAN_SORT_PLAN, 7)], NOW);
    const suggested = shapes.get(key)?.find((shape) => !shape.collscan && shape.sort.length === 0);
    expect(suggested?.equality).toEqual(["status", "region"]);
    expect(suggested?.count).toBe(7);
  });

  it("keeps constants that every sample agrees on", () => {
    const shapes = shapesFromPlans(
      targets,
      "probe",
      [row(SCAN_SORT_PLAN, 1), row(SCAN_SORT_PLAN, 1)],
      NOW,
    );
    const predicateShape = shapes.get(key)?.find((shape) => shape.collscan);
    expect(predicateShape?.constants).toEqual({ status: "open", region: "eu" });
  });

  it("ignores tables nobody asked about and other databases", () => {
    const shapes = shapesFromPlans(
      [{ database: "other", collection: "dbo.orders" }],
      "probe",
      [row(SEEK_PLAN, 5)],
      NOW,
    );
    expect(shapes.size).toBe(0);
  });

  it("seek shapes carry the equality/range split", () => {
    const shapes = shapesFromPlans(targets, "probe", [row(SEEK_PLAN, 8)], NOW);
    const seek = shapes.get(key)?.find((shape) => shape.range.length === 1);
    expect(seek?.equality).toEqual(["customer_id"]);
    expect(seek?.range).toEqual(["created_at"]);
    expect(seek?.sortedInMemory).toBe(false);
  });
});

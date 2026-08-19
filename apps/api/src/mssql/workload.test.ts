import { describe, expect, it } from "vitest";
import { workloadKey } from "../engine/ports";
import { PLAN_PARSE_CHUNK } from "./chunk";
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

  it("merges Query-Store-fragmented literals into one shape", async () => {
    // Same shape, different constants — two query_ids in the store.
    const variant = SCAN_SORT_PLAN.replaceAll("'open'", "'closed'").replaceAll("'eu'", "'us'");
    const shapes = await shapesFromPlans(
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

  it("folds the embedded missing-index suggestion in as its own shape", async () => {
    const shapes = await shapesFromPlans(targets, "probe", [row(SCAN_SORT_PLAN, 7)], NOW);
    const suggested = shapes.get(key)?.find((shape) => !shape.collscan && shape.sort.length === 0);
    expect(suggested?.equality).toEqual(["status", "region"]);
    expect(suggested?.count).toBe(7);
  });

  it("keeps constants that every sample agrees on", async () => {
    const shapes = await shapesFromPlans(
      targets,
      "probe",
      [row(SCAN_SORT_PLAN, 1), row(SCAN_SORT_PLAN, 1)],
      NOW,
    );
    const predicateShape = shapes.get(key)?.find((shape) => shape.collscan);
    expect(predicateShape?.constants).toEqual({ status: "open", region: "eu" });
  });

  it("ignores tables nobody asked about and other databases", async () => {
    const shapes = await shapesFromPlans(
      [{ database: "other", collection: "dbo.orders" }],
      "probe",
      [row(SEEK_PLAN, 5)],
      NOW,
    );
    expect(shapes.size).toBe(0);
  });

  it("seek shapes carry the equality/range split", async () => {
    const shapes = await shapesFromPlans(targets, "probe", [row(SEEK_PLAN, 8)], NOW);
    const seek = shapes.get(key)?.find((shape) => shape.range.length === 1);
    expect(seek?.equality).toEqual(["customer_id"]);
    expect(seek?.range).toEqual(["created_at"]);
    expect(seek?.sortedInMemory).toBe(false);
  });
});

// The parse must not hold the event loop (#230), and that is not something the
// signature can promise: dropping the yield leaves every other test in this
// file green while the API stops answering for the length of a suggest pass.
// So it is measured. deletePatternsFromPlans chunks off the same ./chunk.ts
// helper this exercises, which is the whole reason the helper is shared.
describe("shapesFromPlans yields the event loop while it parses", () => {
  const NOW = new Date("2026-08-14T12:00:00Z");
  const targets = [{ database: "probe", collection: "dbo.orders" }];

  // Four chunks' worth, which is enough to prove the loop is handed back
  // repeatedly and cheap enough that this test costs milliseconds. Each row
  // carries its own literal, so these are distinct documents to parse rather
  // than one document parsed N times.
  const CORPUS = Array.from(
    { length: PLAN_PARSE_CHUNK * 4 },
    (_unused, index): PlanRow => ({
      planXml: SCAN_SORT_PLAN.replaceAll("'open'", `'open${index}'`),
      execs: 1,
      totalIo: 10,
      firstSeen: "2026-08-13T12:00:00Z",
      lastSeen: "2026-08-14T11:00:00Z",
    }),
  );

  // Loop TURNS given away, not milliseconds of stall.
  //
  // This started out as the stall itself: 5,000 plans parsed under a 10 ms timer,
  // asserting the worst lateness stayed under 250 ms — the shape of #230's
  // benchmark, where the numbers came from (1652 ms synchronous, 28 ms chunked at
  // 100, 147 ms at 500). As a benchmark that was right; as a unit test it was
  // measuring the MACHINE. Under `npm run test` three vitest instances share the
  // cores, and a 10 ms timer is legitimately hundreds of milliseconds late with
  // the parse behaving perfectly — it failed on a loaded workstation and passed
  // on the same commit run alone, which is the profile of a test that gets muted
  // rather than fixed.
  //
  // A self-rescheduling setImmediate counts the turns of the event loop the parse
  // let through, and that is the property the code is actually claiming. It cannot
  // be starved into a false pass by a busy host, it needs no threshold, and a
  // synchronous body — including an `async` one that never awaits — runs to
  // completion before the loop gets a single turn, so a revert reads zero and
  // fails on any machine. The stall figures live in ./chunk.ts, where the chunk
  // size is chosen, rather than being re-measured on every CI runner.
  it("hands the loop back once per chunk of rows", async () => {
    let turns = 0;
    let spinning = true;
    const spin = (): void => {
      if (!spinning) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    let shapes: Awaited<ReturnType<typeof shapesFromPlans>>;
    try {
      shapes = await shapesFromPlans(targets, "probe", CORPUS, NOW);
    } finally {
      spinning = false;
    }

    // Only meaningful if the corpus was really parsed.
    expect(shapes.get(workloadKey("probe", "dbo.orders"))?.length).toBeGreaterThan(0);
    // One yield per chunk boundary, so three for four chunks. Asserted as a floor
    // rather than an equality: the counter also ticks on turns the loop takes for
    // its own reasons, and pinning the exact number would make this a test about
    // vitest's scheduling.
    expect(turns).toBeGreaterThanOrEqual(3);
  });
});

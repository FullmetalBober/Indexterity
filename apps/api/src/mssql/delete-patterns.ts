import { XMLParser } from "fast-xml-parser";
import type { DeletePattern } from "../engine/ports";
import { PLAN_PARSE_CHUNK, yieldToEventLoop } from "./chunk";
import { attr, collect, tableOf, type XmlNode } from "./workload";

// Recurring age-based DELETEs, from Query Store plans (#206).
//
// The signal maps from mongo one-for-one — a job that prunes by timestamp on a
// schedule — and the RECOMMENDATION does not, because SQL Server has no TTL
// index. What the advisory says is jobs/suggest.ts's business; this only
// answers "is this table being purged by age, on what column, and how far
// back".
//
// The plan is the source, not the statement text, for the same reason #201 gave:
// showplan XML is machine-emitted with a structured grammar, so the column and
// its table fall out of a tree walk with no T-SQL parsing. Verified against a
// live 2022 CU26 on the three dialects a real purge job is written in:
//
//   DELETE FROM t WHERE created_at < DATEADD(DAY, -90, SYSUTCDATETIME())
//   DELETE FROM t WHERE created_at < @cutoff                  -- parameterised
//   DELETE TOP (1000) FROM t WHERE created_at < DATEADD(...)  -- batched
//
// All three are recorded with their own query_id, execution counts and
// first/last execution times, which is everything the recurrence gate needs.

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseAttributeValue: false,
  parseTagValue: false,
});

// An age-based purge compares the column with `<` or `<=`. `>` is not a purge —
// it is a query for RECENT rows — and equality is not age-based at all.
const OLDER_THAN = new Set(["LT", "LE"]);

// How long the data is kept, from `dateadd(day,(-90),sysutcdatetime())`.
//
// Read off the ScalarString rather than the structured Const pair, deliberately.
// The structured route works — the plan carries the datepart as an internal
// code, measured on 2022 CU26 as 0=year, 2=month, 4=day, 6=hour, 7=minute,
// 8=second, 10=week — but that enum is undocumented, and a release that
// renumbers it would silently turn "90 days" into "90 of something else". The
// ScalarString spells the unit in words beside the same offset, and a unit this
// does not recognise yields null rather than a guess.
//
// Retention is an ENRICHMENT, never load-bearing: a parameterised cutoff
// (`created_at < @cutoff`) carries no value at all, which is the second of the
// three dialects above and probably the most common in the wild. The advisory
// is worth making without it.
const SECONDS_PER_UNIT: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  // Calendar units, as the retention a human means by them. A "6 month"
  // purge window is not 6 × 30 days to the day, and does not need to be: this
  // number is rendered as "≈ N days" in one sentence of advice.
  month: 2_592_000,
  year: 31_536_000,
};

export function retentionSecondsFrom(scalarString: string): number | null {
  const match = /\bdateadd\((\w+),\s*\((-?\d+)\)/i.exec(scalarString);
  if (match === null) return null;
  const seconds = SECONDS_PER_UNIT[(match[1] ?? "").toLowerCase()];
  const offset = Number(match[2]);
  if (seconds === undefined || !Number.isFinite(offset)) return null;
  // A purge subtracts. A positive offset is a cutoff in the FUTURE, which
  // deletes everything and is not a retention window.
  if (offset >= 0) return null;
  return Math.abs(offset) * seconds;
}

export interface DeletePlanRow {
  readonly planXml: string;
  readonly execs: number;
}

// Direct children named `key`, which is what "this ScalarString describes THIS
// comparison" needs — `collect` walks the whole subtree and would pair an
// operator with a comparison nested three levels below it.
function childrenOf(node: XmlNode, key: string): XmlNode[] {
  const child = node[key];
  if (Array.isArray(child)) {
    return child.filter((entry): entry is XmlNode => typeof entry === "object" && entry !== null);
  }
  return typeof child === "object" && child !== null ? [child as XmlNode] : [];
}

// The column this element compares, when it is a column of the target table.
function targetColumn(node: XmlNode, database: string, collection: string): string | null {
  const reference = collect(node, "ColumnReference").find(
    (candidate) => tableOf(candidate, database) === collection,
  );
  return reference === undefined ? null : attr(reference, "Column");
}

// Age predicates under a DELETE statement, in the two shapes the plan writes
// them — both captured live on 2022 CU26.
//
//   SCAN (no supporting index), the case the advisory exists for:
//     <ScalarOperator ScalarString="…[created_at]<dateadd(day,(-90),…)">
//       <Compare CompareOp="LT"> … <ColumnReference … Column="created_at"/>
//
//   SEEK (already indexed), which still earns the partition advice on a large
//   table:
//     <EndRange ScanType="LT">
//       <RangeColumns><ColumnReference … Column="created_at"/></RangeColumns>
//       <RangeExpressions><ScalarOperator ScalarString="dateadd(day,(-200),…)">
//
// Reading only the first would report an unindexed purge and go silent the
// moment somebody indexed it — which is exactly when the table is big enough
// for the second half of the advice to matter.
function agePredicatesIn(
  planXml: string,
  database: string,
  collection: string,
): { field: string; retentionSeconds: number | null }[] {
  let tree: unknown;
  try {
    tree = parser.parse(planXml);
  } catch {
    return [];
  }
  const out: { field: string; retentionSeconds: number | null }[] = [];
  // Per STATEMENT, not per plan: a batch can hold a DELETE and a SELECT, and
  // the SELECT's `created_at < @x` is a query, not a purge.
  for (const statement of collect(tree, "StmtSimple")) {
    if (attr(statement, "StatementType") !== "DELETE") continue;
    for (const operator of collect(statement, "ScalarOperator")) {
      const scalarString = attr(operator, "ScalarString");
      for (const compare of childrenOf(operator, "Compare")) {
        const op = attr(compare, "CompareOp");
        if (op === null || !OLDER_THAN.has(op)) continue;
        const field = targetColumn(compare, database, collection);
        if (field === null) continue;
        out.push({
          field,
          retentionSeconds: scalarString === null ? null : retentionSecondsFrom(scalarString),
        });
      }
    }
    for (const range of collect(statement, "EndRange")) {
      const scanType = attr(range, "ScanType");
      if (scanType === null || !OLDER_THAN.has(scanType)) continue;
      const columns = childrenOf(range, "RangeColumns")[0];
      const field = columns === undefined ? null : targetColumn(columns, database, collection);
      if (field === null) continue;
      const expressions = childrenOf(range, "RangeExpressions")[0];
      const cutoff =
        expressions === undefined ? null : childrenOf(expressions, "ScalarOperator")[0];
      const scalarString =
        cutoff === undefined || cutoff === null ? null : attr(cutoff, "ScalarString");
      out.push({
        field,
        retentionSeconds: scalarString === null ? null : retentionSecondsFrom(scalarString),
      });
    }
  }
  return out;
}

// Fold the plans of one table into one pattern per column.
//
// Pure, so the whole extraction is testable against captured plan XML rather
// than against a server. `count` is EXECUTIONS, not distinct statements: three
// purge jobs run nightly is the same recurring pattern as one run three times,
// and the recurrence gate is asking how often the table gets purged.
//
// Async for the same reason the workload pass is, and with the same guarantee:
// it pauses for the event loop between chunks of rows (./chunk.ts) and is
// otherwise as pure as it was — same inputs, same output, no I/O.
export async function deletePatternsFromPlans(
  rows: readonly DeletePlanRow[],
  database: string,
  collection: string,
): Promise<DeletePattern[]> {
  const byField = new Map<string, { count: number; retentions: number[] }>();
  for (const [index, row] of rows.entries()) {
    // byField is the only state, and it lives outside the loop, so pausing
    // here cannot be observed in the result.
    if (index > 0 && index % PLAN_PARSE_CHUNK === 0) await yieldToEventLoop();
    // One statement may compare the same column twice (a BETWEEN-shaped purge
    // window). That is one purge, so the column is counted once per plan.
    const fields = new Map<string, number | null>();
    for (const predicate of agePredicatesIn(row.planXml, database, collection)) {
      const held = fields.get(predicate.field);
      fields.set(predicate.field, held ?? predicate.retentionSeconds);
    }
    for (const [field, retention] of fields) {
      const bucket = byField.get(field) ?? { count: 0, retentions: [] };
      bucket.count += row.execs;
      // Weighted by executions, so a nightly 90-day purge is not outvoted by a
      // one-off 3-day cleanup that happens to have run once.
      if (retention !== null) {
        for (let i = 0; i < row.execs; i++) bucket.retentions.push(retention);
      }
      byField.set(field, bucket);
    }
  }
  return [...byField.entries()].map(([field, bucket]) => ({
    field,
    count: bucket.count,
    medianRetentionSeconds: bucket.retentions.length === 0 ? null : median(bucket.retentions),
  }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle] ?? 0);
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

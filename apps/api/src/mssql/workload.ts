import { XMLParser } from "fast-xml-parser";
import type { ConstantValue, QueryShape, SortKey } from "../analysis/workload";
import { type WorkloadTarget, workloadKey } from "../engine/ports";
import { PLAN_PARSE_CHUNK, yieldToEventLoop } from "./chunk";

// Query Store plan XML → QueryShape (#201). The plan, not the statement text,
// is the source: showplan XML is machine-emitted with a structured grammar —
// Compare/CompareOp for predicates, OrderByColumn for sorts, SeekPredicateNew
// for the equality-prefix/range split, and every ColumnReference names its
// table — so shapes fall out of a tree walk with no T-SQL parsing at all
// (element anatomy verified against a live 2022, see #201).
//
// Two SQL-Server-specific facts shape the aggregation:
//
//   Query Store groups by TEXT after auto-parameterization, and literals often
//   survive it — `status='open'` and `status='closed'` arrive as two query_ids
//   with the same shape. Shapes are therefore merged by their extracted key,
//   the same move mongo's profiler path makes.
//
//   Plans embed the server's own <MissingIndexes> suggestion with an impact
//   and column roles. That is the create-side hint #36 flagged as over-eager
//   in DMV form — folded here into ordinary QueryShapes carried by the query's
//   own execution counts, it passes through the workload engine's recurrence
//   and cost gates like any observed shape, and the standalone DMVs (with
//   their wipe-on-restart, wipe-on-DDL semantics) are never read at all.

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Plans quote everything; keep values as strings and coerce deliberately.
  parseAttributeValue: false,
  parseTagValue: false,
});

export type XmlNode = Record<string, unknown>;

function asArray(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.filter((entry): entry is XmlNode => isNode(entry));
  return isNode(value) ? [value] : [];
}

export function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null;
}

export function attr(node: XmlNode, name: string): string | null {
  const value = node[`@${name}`];
  return typeof value === "string" ? value : null;
}

// Depth-first: every element named `key` anywhere under `root`.
export function collect(root: unknown, key: string, found: XmlNode[] = []): XmlNode[] {
  if (Array.isArray(root)) {
    for (const entry of root) collect(entry, key, found);
    return found;
  }
  if (!isNode(root)) return found;
  for (const [childKey, child] of Object.entries(root)) {
    if (childKey === key) for (const node of asArray(child)) found.push(node);
    collect(child, key, found);
  }
  return found;
}

// "[dbo]" → "dbo"; plan attributes bracket-quote identifiers.
export function unbracket(value: string | null): string | null {
  if (value === null) return null;
  const inner = /^\[(.*)\]$/.exec(value);
  return inner === undefined || inner === null ? value : (inner[1] ?? "").replaceAll("]]", "]");
}

// schema.table for a ColumnReference / Object / MissingIndex element, or null
// when the element references an expression or an object outside `database`.
//
// The database check is load-bearing, not pedantry: Query Store records a
// query in the database it RAN in, not the one it read, so the store being
// parsed can hold plans over OTHER databases' tables (three-part queries).
// Without the filter, [other].[dbo].[orders] would attribute its shape to the
// analyzed database's own dbo.orders.
export function tableOf(node: XmlNode, database: string): string | null {
  if (unbracket(attr(node, "Database")) !== database) return null;
  const schema = unbracket(attr(node, "Schema"));
  const table = unbracket(attr(node, "Table"));
  if (schema === null || table === null) return null;
  return `${schema}.${table}`;
}

// ConstValue arrives as `'open'`, `(990.00)` or `N'x'`; reduce to a primitive
// or nothing — constants are an optional enrichment, never load-bearing.
export function parseConstValue(raw: string): ConstantValue | null {
  const text = raw.trim().replace(/^\((.*)\)$/s, "$1");
  const quoted = /^N?'(.*)'$/s.exec(text);
  if (quoted !== null) return (quoted[1] ?? "").replaceAll("''", "'");
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return null;
}

interface TableShape {
  equality: Set<string>;
  range: Set<string>;
  sort: SortKey[];
  collscan: boolean;
  sortedInMemory: boolean;
  constants: Record<string, ConstantValue>;
}

export interface MissingIndexSuggestion {
  readonly table: string;
  readonly equality: string[];
  readonly range: string[];
}

export interface PlanShapes {
  readonly perTable: Map<string, TableShape>;
  readonly missing: MissingIndexSuggestion[];
}

function shapeFor(perTable: Map<string, TableShape>, table: string): TableShape {
  const existing = perTable.get(table);
  if (existing !== undefined) return existing;
  const fresh: TableShape = {
    equality: new Set(),
    range: new Set(),
    sort: [],
    collscan: false,
    sortedInMemory: false,
    constants: {},
  };
  perTable.set(table, fresh);
  return fresh;
}

const RANGE_OPS = new Set(["GT", "GE", "LT", "LE"]);

const DML_STATEMENT_TYPES = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);

// Extract per-table shape facts from one showplan XML document, for objects
// living in `database` (see tableOf for why the filter exists).
export function parseShowplanShapes(planXml: string, database: string): PlanShapes {
  const perTable = new Map<string, TableShape>();
  const missing: MissingIndexSuggestion[] = [];
  let root: unknown;
  try {
    root = parser.parse(planXml);
  } catch {
    // An unparseable plan contributes no shape — never a failed collect.
    return { perTable, missing };
  }

  // Only DML plans describe the workload. Query Store also captures DDL —
  // CREATE INDEX's own plan is a full scan feeding a sort, which would hand
  // the suggest engine a phantom missing-index signal every time an index is
  // BUILT (observed live). DML plans always carry StmtSimple
  // StatementType="SELECT|INSERT|…"; DDL plans carry NO StatementType at all
  // (verified on 2022) — so a recognizable DML type must be PRESENT, not
  // merely unopposed.
  const isDml = collect(root, "StmtSimple")
    .map((stmt) => attr(stmt, "StatementType"))
    .some((type) => type !== null && DML_STATEMENT_TYPES.has(type.toUpperCase()));
  if (!isDml) return { perTable, missing };

  // Access operators: IndexScan covers seeks AND scans (clustered or not),
  // TableScan is a heap walk. A scan of the table's own storage — heap or
  // clustered index — is the collection scan; a nonclustered full scan is not
  // (an index answered, just without a seek). Key lookups are the fetch side
  // of someone else's seek and say nothing about the shape.
  const seekRoots: XmlNode[] = [];
  for (const scan of collect(root, "IndexScan")) {
    // A Key Lookup is the fetch side of someone else's seek: its predicate is
    // the clustering key, which is not part of the query's shape.
    if (attr(scan, "Lookup") === "1") continue;
    seekRoots.push(scan);
    for (const object of asArray(scan.Object)) {
      const table = tableOf(object, database);
      if (table === null) continue;
      const shape = shapeFor(perTable, table);
      const hasSeek = asArray(scan.SeekPredicates).length > 0;
      const clustered = attr(object, "IndexKind") === "Clustered";
      if (!hasSeek && clustered) shape.collscan = true;
    }
  }
  for (const scan of collect(root, "TableScan")) {
    for (const object of asArray(scan.Object)) {
      const table = tableOf(object, database);
      if (table !== null) shapeFor(perTable, table).collscan = true;
    }
  }

  // Seek predicates: Prefix = the equality prefix, Start/EndRange = the range
  // column. Collected from the whole SeekPredicateNew subtree because real
  // plans put the keys under an intermediate <SeekKeys> (verified on 2022 —
  // reading direct children silently found nothing). The RangeExpressions
  // beside a Prefix carry the compared constants; a computed expression there
  // appears as a table-less ColumnReference (ConstExpr…), which tableOf
  // filters out of the columns.
  for (const seek of seekRoots.flatMap((scan) => collect(scan, "SeekPredicateNew"))) {
    for (const [element, bucket] of [
      ["Prefix", "equality"],
      ["StartRange", "range"],
      ["EndRange", "range"],
    ] as const) {
      for (const part of collect(seek, element)) {
        const columns: { table: string; name: string }[] = [];
        for (const rangeColumns of asArray(part.RangeColumns)) {
          for (const column of collect(rangeColumns, "ColumnReference")) {
            const table = tableOf(column, database);
            const name = unbracket(attr(column, "Column"));
            if (table === null || name === null) continue;
            columns.push({ table, name });
            shapeFor(perTable, table)[bucket].add(name);
          }
        }
        if (element !== "Prefix") continue;
        // Pair each equality column with the literal it was sought with —
        // positionally, and only when the lists line up; an expression in any
        // slot (no direct Const child) simply contributes no constant.
        const expressions = asArray(part.RangeExpressions).flatMap((wrapper) =>
          asArray(wrapper.ScalarOperator),
        );
        if (expressions.length !== columns.length) continue;
        for (const [i, column] of columns.entries()) {
          const constNode = asArray(expressions[i]?.Const)[0];
          const raw = constNode === undefined ? null : attr(constNode, "ConstValue");
          if (raw === null) continue;
          const value = parseConstValue(raw);
          if (value !== null) shapeFor(perTable, column.table).constants[column.name] = value;
        }
      }
    }
  }

  // Residual predicates: Compare(CompareOp) over Identifier + Const. EQ is
  // equality; GT/GE/LT/LE are ranges; everything else (NE, IsNull, LIKE via
  // Intrinsic) is neither, same lines mongo's collectPredicates draws.
  for (const compare of collect(root, "Compare")) {
    const op = attr(compare, "CompareOp");
    if (op === null) continue;
    const isEquality = op === "EQ";
    if (!isEquality && !RANGE_OPS.has(op)) continue;
    const columns = collect(compare, "ColumnReference").filter(
      (column) => tableOf(column, database) !== null && unbracket(attr(column, "Column")) !== null,
    );
    // Column-to-column comparisons (join predicates) shape both sides as a
    // seek elsewhere; a shape's predicate is column-vs-constant.
    if (columns.length !== 1) continue;
    const column = columns[0];
    if (column === undefined) continue;
    const table = tableOf(column, database);
    const name = unbracket(attr(column, "Column"));
    if (table === null || name === null) continue;
    const shape = shapeFor(perTable, table);
    if (isEquality) {
      shape.equality.add(name);
      const constNode = collect(compare, "Const")[0];
      const raw = constNode === undefined ? null : attr(constNode, "ConstValue");
      if (raw !== null) {
        const value = parseConstValue(raw);
        if (value !== null) shape.constants[name] = value;
      }
    } else {
      shape.range.add(name);
    }
  }

  // Sorts the server performed in memory. OrderBy elements exist only inside
  // Sort/TopSort operators — an index-satisfied ORDER BY has no Sort operator
  // and needs no index, so its absence here is the right answer.
  for (const orderBy of collect(root, "OrderByColumn")) {
    const ascending = attr(orderBy, "Ascending") !== "0";
    for (const column of collect(orderBy, "ColumnReference")) {
      const table = tableOf(column, database);
      const name = unbracket(attr(column, "Column"));
      if (table === null || name === null) continue;
      const shape = shapeFor(perTable, table);
      shape.sortedInMemory = true;
      if (!shape.sort.some((key) => key.field === name)) {
        shape.sort.push({ field: name, direction: ascending ? 1 : -1 });
      }
    }
  }

  // The server's own create-side suggestion, embedded per plan. INCLUDE
  // columns are dropped until IndexSpec can carry them (#204).
  for (const suggestion of collect(root, "MissingIndex")) {
    const table = tableOf(suggestion, database);
    if (table === null) continue;
    const equality: string[] = [];
    const range: string[] = [];
    for (const group of asArray(suggestion.ColumnGroup)) {
      const usage = attr(group, "Usage");
      const bucket = usage === "EQUALITY" ? equality : usage === "INEQUALITY" ? range : null;
      if (bucket === null) continue;
      for (const column of asArray(group.Column)) {
        const name = unbracket(attr(column, "Name"));
        if (name !== null) bucket.push(name);
      }
    }
    if (equality.length + range.length > 0) missing.push({ table, equality, range });
  }

  return { perTable, missing };
}

// One Query Store plan with its lifetime runtime aggregate.
export interface PlanRow {
  readonly planXml: string;
  readonly execs: number;
  readonly totalIo: number;
  readonly firstSeen: Date | string | null;
  readonly lastSeen: Date | string | null;
}

const HOUR_MS = 3_600_000;

function hoursBetween(first: Date | string | null, now: Date): number | undefined {
  if (first === null) return undefined;
  const start = typeof first === "string" ? Date.parse(first) : first.getTime();
  if (!Number.isFinite(start)) return undefined;
  const hours = (now.getTime() - start) / HOUR_MS;
  return hours > 0 ? hours : undefined;
}

interface Accumulated {
  equality: string[];
  sort: SortKey[];
  range: string[];
  collscan: boolean;
  sortedInMemory: boolean;
  count: number;
  totalIo: number;
  firstSeenMs: number | null;
  constants: Record<string, ConstantValue>;
}

function shapeKey(shape: {
  equality: readonly string[];
  sort: readonly SortKey[];
  range: readonly string[];
}): string {
  return [
    [...shape.equality].sort().join(","),
    shape.sort.map((key) => `${key.field}:${key.direction}`).join(","),
    [...shape.range].sort().join(","),
  ].join("\u0000");
}

// Fold every plan's per-table shapes into QueryShapes per workload target.
//
// Pure — the collector feeds it rows; tests feed it fixtures. Async only
// because it pauses for the event loop between chunks of rows; ./chunk.ts holds
// the 1652 ms of stall those pauses exist to avoid. Same inputs, same output,
// no I/O.
export async function shapesFromPlans(
  targets: readonly WorkloadTarget[],
  database: string,
  rows: readonly PlanRow[],
  now: Date,
): Promise<Map<string, QueryShape[]>> {
  const wanted = new Map<string, string>(); // "schema.table" -> workloadKey
  for (const target of targets) {
    if (target.database === database) {
      wanted.set(target.collection, workloadKey(target.database, target.collection));
    }
  }
  const accumulators = new Map<string, Map<string, Accumulated>>(); // workloadKey -> shapeKey -> acc

  const fold = (
    key: string,
    shape: {
      equality: readonly string[];
      sort: readonly SortKey[];
      range: readonly string[];
      collscan: boolean;
      sortedInMemory: boolean;
      constants?: Record<string, ConstantValue>;
    },
    row: PlanRow,
  ): void => {
    const byShape = accumulators.get(key) ?? new Map<string, Accumulated>();
    accumulators.set(key, byShape);
    const id = shapeKey(shape);
    const firstMs =
      row.firstSeen === null
        ? null
        : typeof row.firstSeen === "string"
          ? Date.parse(row.firstSeen)
          : row.firstSeen.getTime();
    const existing = byShape.get(id);
    if (existing === undefined) {
      byShape.set(id, {
        equality: [...shape.equality],
        sort: [...shape.sort],
        range: [...shape.range],
        collscan: shape.collscan,
        sortedInMemory: shape.sortedInMemory,
        count: row.execs,
        totalIo: row.totalIo,
        firstSeenMs: firstMs !== null && Number.isFinite(firstMs) ? firstMs : null,
        constants: { ...shape.constants },
      });
      return;
    }
    existing.count += row.execs;
    existing.totalIo += row.totalIo;
    existing.collscan ||= shape.collscan;
    existing.sortedInMemory ||= shape.sortedInMemory;
    if (firstMs !== null && Number.isFinite(firstMs)) {
      existing.firstSeenMs =
        existing.firstSeenMs === null ? firstMs : Math.min(existing.firstSeenMs, firstMs);
    }
    // Constants only survive when every merged sample agrees — the partial
    // index signal is "compared against THIS value every time".
    for (const [field, value] of Object.entries(existing.constants)) {
      if (shape.constants?.[field] !== value) delete existing.constants[field];
    }
  };

  for (const [index, row] of rows.entries()) {
    // Every accumulator lives outside this loop, so there is no half-built
    // state a pause could be observed in — the fold is identical whether the
    // 5,000 plans are parsed in one breath or in fifty.
    if (index > 0 && index % PLAN_PARSE_CHUNK === 0) await yieldToEventLoop();
    const { perTable, missing } = parseShowplanShapes(row.planXml, database);
    for (const [table, shape] of perTable) {
      const key = wanted.get(table);
      if (key === undefined) continue;
      if (shape.equality.size + shape.range.size + shape.sort.length === 0 && !shape.collscan) {
        continue;
      }
      fold(
        key,
        {
          equality: [...shape.equality],
          sort: shape.sort,
          range: [...shape.range],
          collscan: shape.collscan,
          sortedInMemory: shape.sortedInMemory,
          constants: shape.constants,
        },
        row,
      );
    }
    // The embedded suggestion rides the same execution counts as the plan it
    // came from, so the recurrence gate reads it like any observed shape.
    for (const suggestion of missing) {
      const key = wanted.get(suggestion.table);
      if (key === undefined) continue;
      fold(
        key,
        {
          equality: suggestion.equality,
          sort: [],
          range: suggestion.range,
          collscan: false,
          sortedInMemory: false,
        },
        row,
      );
    }
  }

  const result = new Map<string, QueryShape[]>();
  for (const [key, byShape] of accumulators) {
    const shapes: QueryShape[] = [];
    for (const accumulated of byShape.values()) {
      shapes.push({
        equality: accumulated.equality,
        sort: accumulated.sort,
        range: accumulated.range,
        collscan: accumulated.collscan,
        sortedInMemory: accumulated.sortedInMemory,
        count: accumulated.count,
        // Logical page reads, not documents — the same monotone "what does
        // this shape cost the server" signal, in coarser units. Stated once
        // here rather than scaled by a guessed rows-per-page.
        docsExamined: Math.round(accumulated.totalIo),
        observedForHours: hoursBetween(
          accumulated.firstSeenMs === null ? null : new Date(accumulated.firstSeenMs),
          now,
        ),
        ...(Object.keys(accumulated.constants).length > 0
          ? { constants: accumulated.constants }
          : {}),
      });
    }
    result.set(key, shapes);
  }
  return result;
}

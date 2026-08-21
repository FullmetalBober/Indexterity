import type { QueryShape, SortKey } from "../analysis";
import type { DeletePattern } from "../engine/ports";

// Query shapes out of `pg_stat_statements`, and the hardest piece of this
// adapter — stated plainly rather than discovered later.
//
// MongoDB hands over a shape already parsed ($queryStats keys), and SQL Server
// hands over plan XML naming the predicates and the sorts. PostgreSQL has
// NEITHER: there is no plan store, and pg_stat_statements holds one thing — the
// normalized SQL text. So a shape here means reading SQL.
//
// What makes that tractable rather than reckless is exactly what normalization
// does: every literal is already replaced by `$1`, `$2`, so the text is far more
// regular than what a human typed. Measured on 17.11, the three shapes below
// arrive as:
//
//   SELECT * FROM sales.orders WHERE customer_id = $1 AND status = $2
//                                    ORDER BY created_at DESC LIMIT $3
//   SELECT count(*) FROM sales.orders WHERE total > $1
//                                       AND created_at >= now() - interval $2
//   DELETE FROM sales.orders WHERE created_at < now() - interval $1
//
// This reads predicates and sorts out of that, and REFUSES rather than guesses
// wherever the text stops being simple — a shape that is wrong is worse than a
// shape that is missing, because the first becomes an index somebody has to pay
// for. Every limitation below is a deliberate refusal, not a gap:
//
//   * a subquery, a join, a UNION or a CTE yields nothing. Attributing a
//     predicate to the right table needs a real parser and an alias table, and
//     the point where that is needed is the point where a regex is lying.
//   * OR is not read. `a = $1 OR b = $2` is not served by an index on (a, b),
//     and treating it as equality on both would propose exactly that.
//   * a function call on the left of a comparison is not read as its column:
//     `lower(email) = $1` needs an index on the EXPRESSION, and naming `email`
//     would propose one that cannot serve it.
export interface NormalizedStatement {
  readonly query: string;
  readonly calls: number;
  // total_exec_time is milliseconds; rows is the sum over every call.
  readonly rows: number;
}

// Only the statement forms a single-table shape can be read out of. Anything
// else is left alone by shapesFor.
const SINGLE_TABLE = /^\s*SELECT\b/i;

// The clause boundaries, so a predicate scan does not run past WHERE into
// ORDER BY, and a sort scan does not start inside it.
const WHERE_RE = /\bWHERE\b/i;
const TAIL_RE = /\b(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|FOR\s+(UPDATE|SHARE|NO\s+KEY))\b/i;
const ORDER_BY_RE = /\bORDER\s+BY\b/i;

// Anything that makes single-table attribution a guess.
const COMPLEX = /\b(JOIN|UNION|INTERSECT|EXCEPT|WITH)\b|\(\s*SELECT\b/i;

// `col = $1`, `t.col = $1`, `"Col" = $1`. Deliberately anchored on a bare
// identifier: a function call or an arithmetic expression on the left is skipped
// by the negative lookbehind on `(`.
const IDENT = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
const COLUMN = String.raw`(?:${IDENT}\.)?(${IDENT})`;
const EQUALITY_RE = new RegExp(String.raw`(?<![\w.(])${COLUMN}\s*=\s*\$\d+`, "gi");
const RANGE_RE = new RegExp(String.raw`(?<![\w.(])${COLUMN}\s*(?:>=|<=|>|<|BETWEEN\b)`, "gi");

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1) : name;
}

// The text between one clause keyword and whichever of `until` comes first, or
// "" when the opening keyword is absent. One helper for both clauses: the only
// difference is where each one legally ends, and duplicating the slicing is how
// the two drift apart.
function clauseBetween(query: string, opens: RegExp, until: RegExp): string {
  const open = opens.exec(query);
  if (open === null) return "";
  const rest = query.slice(open.index + open[0].length);
  const end = rest.search(until);
  return end === -1 ? rest : rest.slice(0, end);
}

// The WHERE clause's text, bounded by the first clause that ends it.
function whereClause(query: string): string {
  return clauseBetween(query, WHERE_RE, TAIL_RE);
}

// ORDER BY is followed only by LIMIT/OFFSET/FOR, never by another predicate.
function orderByClause(query: string): string {
  return clauseBetween(query, ORDER_BY_RE, /\b(LIMIT|OFFSET|FOR\s+(UPDATE|SHARE|NO\s+KEY))\b/i);
}

function matchAll(re: RegExp, text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(re)) {
    const name = match[1];
    if (name !== undefined) found.push(unquote(name));
  }
  return found;
}

// Reserved words that can appear where the column regexes look. Filtered by name
// rather than by a smarter grammar, because the list is short and closed and a
// grammar here is the thing this file exists to avoid.
const NOT_COLUMNS = new Set([
  "and",
  "or",
  "not",
  "null",
  "is",
  "in",
  "like",
  "ilike",
  "between",
  "now",
  "interval",
  "true",
  "false",
  "current_date",
  "current_timestamp",
  "localtimestamp",
  "asc",
  "desc",
  "nulls",
  "first",
  "last",
]);

function columns(names: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (!NOT_COLUMNS.has(name.toLowerCase())) seen.add(name);
  }
  return [...seen];
}

// One shape per normalized statement, or nothing where the text stops being
// simple enough to read honestly.
export function shapeOf(statement: NormalizedStatement): QueryShape | null {
  const query = statement.query.replace(/\s+/g, " ").trim();
  if (!SINGLE_TABLE.test(query) || COMPLEX.test(query)) return null;
  const where = whereClause(query);
  // `OR` anywhere in the predicate: an index on the named columns does not serve
  // it, so reading equality out of it would propose one that cannot help.
  if (/\bOR\b/i.test(where)) return null;
  const equality = columns(matchAll(EQUALITY_RE, where));
  const range = columns(matchAll(RANGE_RE, where)).filter((name) => !equality.includes(name));
  const sort = sortKeys(orderByClause(query));
  if (equality.length === 0 && range.length === 0 && sort.length === 0) return null;
  return {
    equality,
    range,
    sort,
    // Whether this shape SCANNED is not knowable from pg_stat_statements: it
    // records text and timing, never a plan. Left false rather than guessed —
    // the create side's recurrence and cost gates are what decide anyway, and a
    // false "it scanned the whole table" would inflate every score.
    collscan: false,
    count: statement.calls,
    // Rows RETURNED, summed across calls, which is not rows examined. Named
    // docsExamined by the port and reported here because it is the only measure
    // of size this source has — a shape returning millions is costing something
    // whether or not an index was used to find them.
    docsExamined: statement.rows,
  };
}

function sortKeys(clause: string): SortKey[] {
  if (clause.trim().length === 0) return [];
  const keys: SortKey[] = [];
  for (const part of clause.split(",")) {
    // A sort on an expression cannot be served by an index on a bare column, so
    // it is skipped for the same reason `lower(email) = $1` is.
    if (/\(/.test(part)) continue;
    const match = new RegExp(String.raw`^\s*${COLUMN}(\s+(?:ASC|DESC))?`, "i").exec(part);
    const name = match?.[1];
    if (name === undefined || NOT_COLUMNS.has(unquote(name).toLowerCase())) continue;
    keys.push({
      field: unquote(name),
      direction: /desc/i.test(match?.[2] ?? "") ? -1 : 1,
    });
  }
  return keys;
}

// Recurring age-based DELETEs, which are the same signal as MongoDB's
// `deleteMany({ts: {$lt: date}})` and SQL Server's Query Store equivalent: a job
// pruning by timestamp on a schedule. What the advisory then SAYS differs by
// engine — Postgres has no TTL index, so the recommendation is a supporting
// index or a partition, which is jobs/suggest.ts's business.
//
// `medianRetentionSeconds` is always null here, and that is the case ports.ts
// already models rather than a shortfall: normalization replaces the cutoff, so
// `created_at < now() - interval $1` carries the predicate and not the number.
const DELETE_RE = new RegExp(
  String.raw`^\s*DELETE\s+FROM\s+\S+\s+WHERE\s+(?:${IDENT}\.)?(${IDENT})\s*<=?\s`,
  "i",
);

export function deletePatternOf(statement: NormalizedStatement): DeletePattern | null {
  const query = statement.query.replace(/\s+/g, " ").trim();
  const match = DELETE_RE.exec(query);
  const field = match?.[1];
  if (field === undefined || NOT_COLUMNS.has(unquote(field).toLowerCase())) return null;
  // A purge compares against a moving cutoff. One comparing against a bound
  // parameter alone could be deleting a single row by id, so the shape has to
  // look like time arithmetic to count.
  if (!/\b(now|current_timestamp|current_date|localtimestamp)\b/i.test(query)) return null;
  return { field: unquote(field), count: statement.calls, medianRetentionSeconds: null };
}

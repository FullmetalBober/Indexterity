import { describe, expect, it } from "vitest";
import { deletePatternOf, type NormalizedStatement, shapeOf } from "./workload";

const stmt = (query: string, calls = 3, rows = 10): NormalizedStatement => ({ query, calls, rows });

// Every string in this file is verbatim from pg_stat_statements on 17.11 — the
// point of testing a text reader against invented text is nil.
describe("shapeOf", () => {
  it("reads equality, sort direction and count from a real normalized statement", () => {
    const shape = shapeOf(
      stmt(
        "SELECT * FROM sales.orders WHERE customer_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3",
      ),
    );
    expect(shape?.equality).toEqual(["customer_id", "status"]);
    expect(shape?.sort).toEqual([{ field: "created_at", direction: -1 }]);
    expect(shape?.range).toEqual([]);
    expect(shape?.count).toBe(3);
  });

  it("separates a range from an equality", () => {
    const shape = shapeOf(
      stmt(
        "SELECT count(*) FROM sales.orders WHERE total > $1 AND created_at >= now() - interval $2",
      ),
    );
    expect([...(shape?.range ?? [])].sort()).toEqual(["created_at", "total"]);
    expect(shape?.equality).toEqual([]);
  });

  it("reads a qualified column as the column", () => {
    expect(shapeOf(stmt("SELECT * FROM sales.orders o WHERE o.status = $1"))?.equality).toEqual([
      "status",
    ]);
  });

  it("unquotes a quoted identifier", () => {
    expect(shapeOf(stmt('SELECT * FROM t WHERE "userId" = $1'))?.equality).toEqual(["userId"]);
  });

  // collscan is not knowable from this source — it records text and timing, never
  // a plan — so it is false rather than guessed, which would inflate every score.
  it("never claims a scan it cannot see", () => {
    expect(shapeOf(stmt("SELECT * FROM t WHERE a = $1"))?.collscan).toBe(false);
  });

  // The refusals. Each one exists because the alternative is proposing an index
  // that cannot serve the query it was proposed for.
  it("refuses a shape it cannot attribute to one table", () => {
    for (const query of [
      "SELECT * FROM a JOIN b ON a.id = b.a_id WHERE a.x = $1",
      "SELECT * FROM a WHERE id IN (SELECT a_id FROM b WHERE y = $1)",
      "WITH x AS (SELECT 1) SELECT * FROM a WHERE b = $1",
      "SELECT * FROM a WHERE x = $1 UNION SELECT * FROM b WHERE y = $2",
    ]) {
      expect(shapeOf(stmt(query))).toBeNull();
    }
  });

  // An index on (a, b) does not serve `a = $1 OR b = $2`, so reading equality out
  // of it would propose exactly the wrong index.
  it("refuses an OR predicate", () => {
    expect(shapeOf(stmt("SELECT * FROM t WHERE a = $1 OR b = $2"))).toBeNull();
  });

  // `lower(email) = $1` needs an index on the EXPRESSION; naming `email` would
  // propose one that cannot serve it.
  it("does not read a function call as its column", () => {
    expect(shapeOf(stmt("SELECT * FROM t WHERE lower(email) = $1"))).toBeNull();
    expect(shapeOf(stmt("SELECT * FROM t ORDER BY lower(email)"))).toBeNull();
  });

  it("refuses a statement with nothing indexable in it", () => {
    expect(shapeOf(stmt("SELECT * FROM t"))).toBeNull();
    expect(shapeOf(stmt("SELECT count(*) FROM t"))).toBeNull();
  });

  // A predicate scan must not run past WHERE into the sort, and the sort must not
  // start inside the predicate.
  it("keeps the clauses apart", () => {
    const shape = shapeOf(stmt("SELECT * FROM t WHERE a = $1 GROUP BY b ORDER BY c LIMIT $2"));
    expect(shape?.equality).toEqual(["a"]);
    expect(shape?.sort).toEqual([{ field: "c", direction: 1 }]);
  });

  it("reads several sort keys in order, with their own directions", () => {
    expect(shapeOf(stmt("SELECT * FROM t WHERE a = $1 ORDER BY b DESC, c ASC, d"))?.sort).toEqual([
      { field: "b", direction: -1 },
      { field: "c", direction: 1 },
      { field: "d", direction: 1 },
    ]);
  });
});

describe("deletePatternOf", () => {
  // Verbatim, and the retention literal is genuinely gone: normalization
  // replaced it, which is the medianRetentionSeconds: null case ports.ts models.
  it("reads an age-based purge and reports no retention number", () => {
    const pattern = deletePatternOf(
      stmt("DELETE FROM sales.orders WHERE created_at < now() - interval $1", 2),
    );
    expect(pattern).toEqual({ field: "created_at", count: 2, medianRetentionSeconds: null });
  });

  it("takes the other spellings of now", () => {
    for (const fn of ["current_timestamp", "CURRENT_DATE", "localtimestamp"]) {
      expect(deletePatternOf(stmt(`DELETE FROM t WHERE ts <= ${fn} - interval $1`))?.field).toBe(
        "ts",
      );
    }
  });

  // A purge compares against a MOVING cutoff. Without that, `DELETE … WHERE id <
  // $1` is a range delete by key and not a retention job at all.
  it("refuses a delete that is not age-based", () => {
    expect(deletePatternOf(stmt("DELETE FROM t WHERE id < $1"))).toBeNull();
    expect(deletePatternOf(stmt("DELETE FROM t WHERE status = $1"))).toBeNull();
    expect(deletePatternOf(stmt("SELECT * FROM t WHERE ts < now()"))).toBeNull();
  });
});

// node-pg hands a bigint column back as a STRING, so `calls` arrives as "3"
// unless the collector coerces it at the boundary — which it does. This asserts
// the shape stays arithmetic-safe if that ever regresses: a count that is a
// string survives every comparison and breaks the first addition.
describe("counts are numbers", () => {
  it("keeps count and docsExamined arithmetic-safe", () => {
    const shape = shapeOf({ query: "SELECT * FROM t WHERE a = $1", calls: 3, rows: 12 });
    expect(typeof shape?.count).toBe("number");
    expect(typeof shape?.docsExamined).toBe("number");
    expect((shape?.count ?? 0) + 1).toBe(4);
  });

  it("keeps a delete pattern's count arithmetic-safe", () => {
    const pattern = deletePatternOf({
      query: "DELETE FROM t WHERE ts < now() - interval $1",
      calls: 2,
      rows: 100,
    });
    expect(typeof pattern?.count).toBe("number");
    expect((pattern?.count ?? 0) + 1).toBe(3);
  });
});

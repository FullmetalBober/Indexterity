import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresConnection } from "./connection";

const client = {
  query: vi.fn(async (_text: string): Promise<{ rows: unknown[] }> => ({ rows: [] })),
  release: vi.fn(),
};
const pool = { connect: vi.fn(async () => client) };

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  pgPool: vi.fn(async () => pool),
}));

// The index build budget (#410), tested HERE rather than against a live server.
//
// An integration test cannot see this: node-pg hands `query()` and `execute()`
// different clients out of the pool, so a leaked `SET` lands on a connection the
// assertion never looks at — a version of this test with the RESET deleted
// passed against real postgres, which is worse than no test.
//
// What matters is the sequence issued on ONE client, and that is exactly what a
// stub can show.
describe("PostgresConnection.execute", () => {
  beforeEach(() => {
    client.query.mockClear();
    client.release.mockClear();
  });

  const statements = (): string[] => client.query.mock.calls.map((call) => String(call[0]));

  it("leaves an ordinary statement on the pool's own budget", async () => {
    const conn = new PostgresConnection("postgres://u:p@h:5432/d", {
      allowInvalidCertificates: false,
      allowInvalidHostnames: false,
      insecure: true,
    });

    await conn.execute("DROP INDEX CONCURRENTLY IF EXISTS x");

    // No SET, no RESET: a drop is not a build, and touching the session for it
    // would be two extra round trips per statement for nothing.
    expect(statements()).toEqual(["DROP INDEX CONCURRENTLY IF EXISTS x"]);
  });

  it("raises the budget around a build and puts it back", async () => {
    const conn = new PostgresConnection("postgres://u:p@h:5432/d", {
      allowInvalidCertificates: false,
      allowInvalidHostnames: false,
      insecure: true,
    });

    await conn.execute("CREATE INDEX CONCURRENTLY x ON t (c)", "", { build: true });

    const issued = statements();
    expect(issued[0]).toMatch(/^SET statement_timeout = \d+$/);
    expect(issued[1]).toBe("CREATE INDEX CONCURRENTLY x ON t (c)");
    // The one that matters. node-pg hands this connection to whoever asks next,
    // so a budget left behind would put hours on every later read through it.
    expect(issued[2]).toBe("RESET statement_timeout");
    expect(client.release).toHaveBeenCalled();
  });

  it("puts the budget back even when the build fails", async () => {
    const conn = new PostgresConnection("postgres://u:p@h:5432/d", {
      allowInvalidCertificates: false,
      allowInvalidHostnames: false,
      insecure: true,
    });
    client.query.mockImplementation(async (text: string) => {
      if (text.startsWith("CREATE")) throw new Error("canceling statement due to timeout");
      return { rows: [] };
    });

    await expect(
      conn.execute("CREATE INDEX CONCURRENTLY x ON t (c)", "", { build: true }),
    ).rejects.toThrow(/canceling statement/);

    // The failing case is the one that leaks if the reset is not in a finally —
    // and a build timing out is precisely when this path runs.
    expect(statements()).toContain("RESET statement_timeout");
    expect(client.release).toHaveBeenCalled();
    client.query.mockImplementation(async () => ({ rows: [] }));
  });
});

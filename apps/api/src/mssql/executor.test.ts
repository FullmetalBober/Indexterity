import { describe, expect, it } from "vitest";
import { stub } from "../test-utils";
import type { MssqlConnection } from "./connection";
import { MssqlIndexExecutor } from "./executor";

interface IndexStateRow {
  type: number;
  isUnique: boolean;
  isPrimaryKey: boolean;
  isUniqueConstraint: boolean;
  isDisabled: boolean;
}

// A stub standing in for the one method surface the executor touches. Executed
// statements are recorded so a refusal can assert nothing reached the server.
function stubConnection(state: IndexStateRow | null, online = true) {
  const executed: string[] = [];
  const conn = {
    // Generic, like the real `query<T>`.
    query: <T>() => Promise.resolve((state === null ? [] : [state]) as T[]),
    execute: (text: string) => {
      executed.push(text);
      return Promise.resolve();
    },
    serverVersion: () => Promise.resolve({ major: 16, minor: 0, text: "16.0.4250.1" }),
    supportsOnlineRebuild: () => Promise.resolve(online),
  };
  return { conn: stub<MssqlConnection>(conn), executed };
}

const plain: IndexStateRow = {
  type: 2,
  isUnique: false,
  isPrimaryKey: false,
  isUniqueConstraint: false,
  isDisabled: false,
};

describe("MssqlIndexExecutor structural guards", () => {
  it("refuses every write in read-only mode", async () => {
    const { conn, executed } = stubConnection(plain);
    const executor = new MssqlIndexExecutor(conn, true);
    await expect(executor.hide("db", "dbo.t", "ix")).rejects.toThrow(/read-only/);
    await expect(executor.drop("db", "dbo.t", "ix")).rejects.toThrow(/read-only/);
    await expect(executor.create("db", "dbo.t", { a: 1 }, {})).rejects.toThrow(/read-only/);
    expect(executed).toEqual([]);
  });

  it("hides a plain nonclustered index with DISABLE", async () => {
    const { conn, executed } = stubConnection(plain);
    await new MssqlIndexExecutor(conn, false).hide("db", "dbo.orders", "ix");
    expect(executed).toEqual(["ALTER INDEX [ix] ON [db].[dbo].[orders] DISABLE"]);
  });

  it("refuses to disable clustered, primary-key and unique indexes", async () => {
    // Measured on 2022: clustered = table offline (Msg 8655); PK = referencing
    // FKs silently disabled; unique = uniqueness stops being enforced.
    for (const state of [
      { ...plain, type: 1 },
      { ...plain, isPrimaryKey: true },
      { ...plain, isUnique: true },
      { ...plain, isUniqueConstraint: true },
    ]) {
      const { conn, executed } = stubConnection(state);
      await expect(new MssqlIndexExecutor(conn, false).hide("db", "dbo.t", "ix")).rejects.toThrow(
        /refusing to disable/,
      );
      expect(executed).toEqual([]);
    }
  });

  it("unhide rebuilds ONLINE where the edition can, offline elsewhere", async () => {
    const hidden = { ...plain, isDisabled: true };
    const online = stubConnection(hidden, true);
    await new MssqlIndexExecutor(online.conn, false).unhide("db", "dbo.orders", "ix");
    expect(online.executed).toEqual([
      "ALTER INDEX [ix] ON [db].[dbo].[orders] REBUILD WITH (ONLINE = ON)",
    ]);
    const standard = stubConnection(hidden, false);
    await new MssqlIndexExecutor(standard.conn, false).unhide("db", "dbo.orders", "ix");
    expect(standard.executed).toEqual(["ALTER INDEX [ix] ON [db].[dbo].[orders] REBUILD"]);
  });

  it("hide and unhide are idempotent", async () => {
    const disabled = stubConnection({ ...plain, isDisabled: true });
    await new MssqlIndexExecutor(disabled.conn, false).hide("db", "dbo.t", "ix");
    expect(disabled.executed).toEqual([]);
    const enabled = stubConnection(plain);
    await new MssqlIndexExecutor(enabled.conn, false).unhide("db", "dbo.t", "ix");
    expect(enabled.executed).toEqual([]);
  });

  it("refuses to drop constraint-backing indexes", async () => {
    const { conn, executed } = stubConnection({ ...plain, isPrimaryKey: true });
    await expect(new MssqlIndexExecutor(conn, false).drop("db", "dbo.t", "pk")).rejects.toThrow(
      /schema change/,
    );
    expect(executed).toEqual([]);
  });

  it("creates with directions, uniqueness and a SQL filter", async () => {
    const { conn, executed } = stubConnection(plain);
    await new MssqlIndexExecutor(conn, false).create(
      "db",
      "dbo.orders",
      { customer_id: 1, created_at: -1 },
      { name: "ix_c", unique: true, partialFilterExpression: { definition: "([status]='open')" } },
    );
    expect(executed).toEqual([
      "CREATE UNIQUE NONCLUSTERED INDEX [ix_c] ON [db].[dbo].[orders] " +
        "([customer_id] ASC, [created_at] DESC) WHERE ([status]='open')",
    ]);
  });

  it("restores covering columns, INCLUDE before WHERE", async () => {
    const { conn, executed } = stubConnection(plain);
    await new MssqlIndexExecutor(conn, false).create(
      "db",
      "dbo.orders",
      { customer_id: 1 },
      {
        name: "ix_c",
        include: ["total", "email"],
        partialFilterExpression: { definition: "([status]='open')" },
      },
    );
    expect(executed).toEqual([
      "CREATE NONCLUSTERED INDEX [ix_c] ON [db].[dbo].[orders] ([customer_id] ASC) " +
        "INCLUDE ([total], [email]) WHERE ([status]='open')",
    ]);
  });

  // Msg 1911: a column cannot be both a key and an include. Dropping it here
  // keeps a spec that names one in both lists from turning into a failed undo.
  it("drops an included column that is already a key", async () => {
    const { conn, executed } = stubConnection(plain);
    await new MssqlIndexExecutor(conn, false).create(
      "db",
      "dbo.orders",
      { customer_id: 1 },
      { name: "ix_c", include: ["customer_id", "total"] },
    );
    expect(executed).toEqual([
      "CREATE NONCLUSTERED INDEX [ix_c] ON [db].[dbo].[orders] ([customer_id] ASC) " +
        "INCLUDE ([total])",
    ]);
  });

  it("refuses a filter it cannot translate", async () => {
    const { conn, executed } = stubConnection(plain);
    await expect(
      new MssqlIndexExecutor(conn, false).create(
        "db",
        "dbo.orders",
        { a: 1 },
        { partialFilterExpression: { status: { $exists: true } } },
      ),
    ).rejects.toThrow(/non-SQL filter/);
    expect(executed).toEqual([]);
  });

  it("quotes hostile identifiers", async () => {
    const { conn, executed } = stubConnection(plain);
    await new MssqlIndexExecutor(conn, false).hide("db", "dbo.ord]ers", "ix]x");
    expect(executed).toEqual(["ALTER INDEX [ix]]x] ON [db].[dbo].[ord]]ers] DISABLE"]);
  });
});

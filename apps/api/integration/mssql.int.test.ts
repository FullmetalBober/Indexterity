import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EngineSession, workloadKey } from "../src/engine/ports";
import { detectEngine } from "../src/engine/registry";
import { collectSnapshots } from "../src/mongo/snapshots";
import { mssqlAdapter } from "../src/mssql/adapter";
import { MssqlConnection } from "../src/mssql/connection";

// Adapter-level integration against a real SQL Server (2022 in CI). Everything
// the drop pipeline needs from the engine, proven end to end: diagnose,
// collect through the engine-neutral snapshot pass, and the full
// create → hide → unhide → drop cycle with the structural guards.
//
// Skipped without MSSQL_URL — locally:
//   podman run -d --name mssql --network host -e ACCEPT_EULA=Y \
//     -e 'MSSQL_SA_PASSWORD=Int3gration!Pass' mcr.microsoft.com/mssql/server:2022-latest
//   MSSQL_URL='mssql://sa:Int3gration!Pass@localhost:1433?trustservercertificate=true' \
//     npm run test:int -w apps/api -- integration/mssql.int.test.ts
const MSSQL_URL = process.env.MSSQL_URL;

// The suite writes through its own connection to seed; the adapter is what is
// under test. TrustServerCertificate is expected in MSSQL_URL — the container
// serves a self-signed certificate.
const OVERRIDES = { allowInvalidCertificates: true, allowInvalidHostnames: false, insecure: false };
const DB = "indexterity_int";

describe.skipIf(MSSQL_URL === undefined)("mssql adapter against a live server", () => {
  let seed: MssqlConnection;
  let session: EngineSession;

  beforeAll(async () => {
    seed = new MssqlConnection(MSSQL_URL as string, OVERRIDES);
    await seed.connect();
    await seed.execute(`IF DB_ID('${DB}') IS NOT NULL DROP DATABASE [${DB}]`);
    await seed.execute(`CREATE DATABASE [${DB}]`);
    await seed.execute(
      `CREATE TABLE [${DB}].dbo.orders(
         id int IDENTITY CONSTRAINT pk_orders PRIMARY KEY,
         customer_id int NOT NULL,
         email varchar(80) NULL,
         status varchar(20) NOT NULL DEFAULT 'open')`,
    );
    await seed.execute(`CREATE INDEX ix_customer ON [${DB}].dbo.orders(customer_id)`);
    await seed.execute(
      `CREATE UNIQUE INDEX ux_email ON [${DB}].dbo.orders(email) WHERE email IS NOT NULL`,
    );
    await seed.execute(
      `INSERT INTO [${DB}].dbo.orders(customer_id, email)
       SELECT TOP 5000 ABS(CHECKSUM(NEWID())) % 500, CONVERT(varchar(80), NEWID())
       FROM sys.all_columns a CROSS JOIN sys.all_columns b`,
    );
    // 2022 creates new databases with QUERY_CAPTURE_MODE = AUTO, which skips
    // cheap one-off statements — the workload assertions need the seeded
    // queries captured deterministically.
    await seed.execute(`ALTER DATABASE [${DB}] SET QUERY_STORE (QUERY_CAPTURE_MODE = ALL)`);
    // Drive seeks through ix_customer so usage stats have something to say,
    // and workload shapes for collectWorkload: equality + an in-memory sort.
    // Two things are deliberate here. The queries run IN the analyzed
    // database's context (USE) — Query Store records a query in the database
    // it ran in, not the one it read, and a three-part query from master
    // would land in master's nonexistent store. And the sort column is one NO
    // index can order by: SQL Server serves ORDER BY <indexed col> DESC with
    // a backward scan and emits no Sort operator at all (#207). The two
    // literal variants prove shape merging across Query Store's per-text
    // fragmentation.
    await seed.query(`USE [${DB}]; SELECT COUNT(*) AS n FROM dbo.orders WHERE customer_id = 42`);
    await seed.query(
      `USE [${DB}]; SELECT TOP 3 id FROM dbo.orders WHERE customer_id = 7 ORDER BY status DESC`,
    );
    await seed.query(
      `USE [${DB}]; SELECT TOP 3 id FROM dbo.orders WHERE customer_id = 8 ORDER BY status DESC`,
    );
    // Equality + range in one seek. Two predicates on purpose: the server
    // auto-parameterizes single-predicate trivial plans AND removes those
    // Query Store entries again on index DDL against the table (observed
    // live) — the hide-lifecycle test below performs exactly such DDL, so
    // the workload assertions ride only on non-trivial plans.
    await seed.query(
      `USE [${DB}]; SELECT COUNT(*) AS n FROM dbo.orders WHERE customer_id = 9 AND id > 100`,
    );
    session = await mssqlAdapter.open(MSSQL_URL as string, OVERRIDES);
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    if (seed !== undefined) {
      await seed.execute(`IF DB_ID('${DB}') IS NOT NULL DROP DATABASE [${DB}]`).catch(() => {});
      await seed.close();
    }
  });

  it("is detected from the connection string alone", () => {
    expect(detectEngine(MSSQL_URL as string)).toBe("MSSQL");
  });

  it("diagnoses sa as ready and able to apply", async () => {
    const diagnosis = await mssqlAdapter.diagnose(MSSQL_URL as string, OVERRIDES);
    expect(diagnosis.reachable).toBe(true);
    expect(diagnosis.ready).toBe(true);
    expect(diagnosis.canApply).toBe(true);
    expect(diagnosis.username).toBe("sa");
  });

  it("collects specs, usage and sizes through the engine-neutral snapshot pass", async () => {
    const result = await collectSnapshots(session);
    const names = result.snapshots
      .filter((snapshot) => snapshot.database === DB)
      .map((snapshot) => snapshot.indexName);
    expect(names).toContain("pk_orders");
    expect(names).toContain("ix_customer");
    expect(names).toContain("ux_email");

    const customer = result.snapshots.find(
      (snapshot) => snapshot.database === DB && snapshot.indexName === "ix_customer",
    );
    expect(customer).toBeDefined();
    expect(customer?.sizeBytes).toBeGreaterThan(0);
    const member = customer?.perMember[0];
    expect(member?.ops).toBeGreaterThan(0); // the seeded seek
    expect(typeof member?.ops).toBe("number"); // bigint columns must not arrive as strings
    expect(Date.parse(member?.since ?? "")).toBeGreaterThan(0);

    const pk = result.snapshots.find(
      (snapshot) => snapshot.database === DB && snapshot.indexName === "pk_orders",
    )?.spec as { unique: boolean; isShardKey: boolean } | undefined;
    expect(pk?.unique).toBe(true);
    expect(pk?.isShardKey).toBe(true); // clustered = never-drop

    const unique = result.snapshots.find(
      (snapshot) => snapshot.database === DB && snapshot.indexName === "ux_email",
    )?.spec as { unique: boolean; partial: boolean } | undefined;
    expect(unique?.unique).toBe(true);
    expect(unique?.partial).toBe(true); // filtered index
  });

  it("runs the full hide lifecycle and honours the guards", async () => {
    const executor = session.executor(false);
    await executor.create(DB, "dbo.orders", { status: 1, customer_id: -1 }, { name: "ix_cycle" });

    await executor.hide(DB, "dbo.orders", "ix_cycle");
    let specs = await session.collector.listIndexes(DB, "dbo.orders");
    expect(specs.find((spec) => spec.name === "ix_cycle")?.hidden).toBe(true);
    // A disabled index owns no pages; its reported size is honestly zero.
    expect((await session.collector.indexSizes(DB, "dbo.orders")).ix_cycle).toBe(0);

    await executor.unhide(DB, "dbo.orders", "ix_cycle");
    specs = await session.collector.listIndexes(DB, "dbo.orders");
    expect(specs.find((spec) => spec.name === "ix_cycle")?.hidden).toBe(false);

    await executor.drop(DB, "dbo.orders", "ix_cycle");
    specs = await session.collector.listIndexes(DB, "dbo.orders");
    expect(specs.find((spec) => spec.name === "ix_cycle")).toBeUndefined();

    // The classes DISABLE must never touch (measured on 2022 — see #36).
    await expect(executor.hide(DB, "dbo.orders", "ux_email")).rejects.toThrow(/unique/);
    await expect(executor.hide(DB, "dbo.orders", "pk_orders")).rejects.toThrow(/clustered|primary/);

    // Read-only mode refuses structurally, before any dial.
    await expect(session.executor(true).hide(DB, "dbo.orders", "ix_customer")).rejects.toThrow(
      /read-only/,
    );
  });

  it("keeps a read-only executor from creating too", async () => {
    await expect(
      session.executor(true).create(DB, "dbo.orders", { status: 1 }, {}),
    ).rejects.toThrow(/read-only/);
  });

  it("collects query shapes from Query Store plans (#201)", async () => {
    const workload = await session.collector.collectWorkload([
      { database: DB, collection: "dbo.orders" },
    ]);
    const shapes = workload.get(workloadKey(DB, "dbo.orders")) ?? [];
    expect(shapes.length).toBeGreaterThan(0);

    // The two literal variants of the same query must arrive as ONE shape —
    // Query Store fragments by text, the extractor merges by shape.
    const sorted = shapes.find(
      (shape) => shape.sortedInMemory === true && shape.equality.includes("customer_id"),
    );
    expect(sorted, JSON.stringify(shapes)).toBeDefined();
    expect(sorted?.count).toBeGreaterThanOrEqual(2);
    expect(sorted?.sort).toEqual([{ field: "status", direction: -1 }]);
    // Disagreeing literals (7 vs 8) must not survive as a constant.
    expect(sorted?.constants?.customer_id).toBeUndefined();
    expect(sorted?.docsExamined ?? 0).toBeGreaterThan(0);

    // The two-predicate seek arrives with the equality/range split intact.
    // No constants are asserted anywhere live: auto-parameterization can
    // erase literals server-side, so constants are best-effort by design
    // (unit tests pin the extraction itself).
    const seek = shapes.find(
      (shape) => shape.equality.includes("customer_id") && shape.range.includes("id"),
    );
    expect(seek, JSON.stringify(shapes)).toBeDefined();
    expect(seek?.sortedInMemory).toBe(false);
    expect(seek?.count).toBeGreaterThanOrEqual(1);

    // And nothing DDL-shaped: the hide-lifecycle test built and dropped
    // ix_cycle before this ran, and CREATE INDEX's own scan+sort plan must
    // not read as workload.
    const phantom = shapes.find((shape) => shape.sort.length >= 3 && shape.equality.length === 0);
    expect(phantom).toBeUndefined();
  });
});

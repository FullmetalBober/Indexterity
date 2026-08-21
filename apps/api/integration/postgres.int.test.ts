import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EngineSession, workloadKey } from "../src/engine/ports";
import { detectEngine } from "../src/engine/registry";
import { ProvisionDeniedError } from "../src/mongo/provision";
import { postgresAdapter } from "../src/postgres/adapter";
import { PostgresConnection } from "../src/postgres/connection";
import { HideUnsupportedError } from "../src/postgres/executor";
import { provisionPostgresScopedUser } from "../src/postgres/provision";

// Adapter-level integration against a real PostgreSQL, and the job that turns
// every claim in the postgres/ modules into one CI enforces rather than one a
// laptop once observed.
//
// The cases chosen are the ones that CANNOT be unit-tested, because each is a
// fact about the server rather than about our code: what the catalog reports for
// a DESC/INCLUDE/partial index, that the scoped role is refused on data and on
// DDL, that a failed concurrent build leaves an invalid index behind and that we
// clean it up, and that hide is impossible.
//
// Skipped without POSTGRES_URL — locally:
//   podman run -d --name pgint -p 5433:5432 -e POSTGRES_PASSWORD=probe \
//     docker.io/library/postgres:17 -c shared_preload_libraries=pg_stat_statements
//   POSTGRES_URL='postgresql://postgres:probe@localhost:5433/postgres?sslmode=disable' \
//     npm run test:int -w apps/api -- integration/postgres.int.test.ts
const POSTGRES_URL = process.env.POSTGRES_URL;

// The container serves no certificate, so the suite's own string says
// sslmode=disable and the deployment flag below consents to it. A real cluster
// would say verify-full; this asserts the guard can be satisfied, not bypassed.
const OVERRIDES = { allowInvalidCertificates: false, allowInvalidHostnames: false, insecure: true };
const SCHEMA = "indexterity_int";

describe.skipIf(POSTGRES_URL === undefined)("postgres adapter against a live server", () => {
  let seed: PostgresConnection;
  let session: EngineSession;

  beforeAll(async () => {
    seed = new PostgresConnection(POSTGRES_URL as string, OVERRIDES);
    await seed.connect();
    await seed.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await seed.execute(`CREATE SCHEMA ${SCHEMA}`);
    await seed.execute(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    await seed.execute(
      `CREATE TABLE ${SCHEMA}.orders (
         id bigserial PRIMARY KEY,
         customer_id int NOT NULL,
         email text NOT NULL,
         status text NOT NULL,
         total numeric(10, 2) NOT NULL,
         created_at timestamptz NOT NULL
       )`,
    );
    await seed.execute(
      `INSERT INTO ${SCHEMA}.orders (customer_id, email, status, total, created_at)
         SELECT g, 'c' || g || '@x.test', (ARRAY['new','paid'])[1 + (g % 2)],
                (g % 500)::numeric, now() - (g % 400) * interval '1 day'
           FROM generate_series(1, 5000) g`,
    );
    // One of every shape listIndexes has to read correctly.
    await seed.execute(`CREATE UNIQUE INDEX orders_email_key ON ${SCHEMA}.orders (email)`);
    await seed.execute(
      `CREATE INDEX orders_cust_created ON ${SCHEMA}.orders (customer_id, created_at DESC)`,
    );
    await seed.execute(
      `CREATE INDEX orders_paid ON ${SCHEMA}.orders (created_at) WHERE status = 'paid'`,
    );
    await seed.execute(
      `CREATE INDEX orders_cover ON ${SCHEMA}.orders (status) INCLUDE (total, email)`,
    );
    await seed.execute(`ANALYZE ${SCHEMA}.orders`);
    session = await postgresAdapter.open(POSTGRES_URL as string, OVERRIDES);
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    await seed?.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await seed?.close();
  });

  it("is the engine the registry picks for this string", () => {
    expect(detectEngine(POSTGRES_URL as string)).toBe("POSTGRESQL");
    expect(postgresAdapter.capabilities).toEqual({
      hideIndexes: false,
      provisionScopedUsers: true,
    });
  });

  // Every one of these is what the catalog says, not what we hoped it says.
  it("reads each index shape out of the catalog exactly", async () => {
    const specs = await session.collector.listIndexes("postgres", `${SCHEMA}.orders`);
    const byName = new Map(specs.map((spec) => [spec.name, spec]));

    // DESC on the second key only.
    expect(byName.get("orders_cust_created")?.keys).toEqual([
      { field: "customer_id", direction: 1 },
      { field: "created_at", direction: -1 },
    ]);
    // INCLUDE columns are not keys — the distinction listIndexes draws from
    // indnkeyatts, and the one that decides what an index can cover.
    expect(byName.get("orders_cover")?.keys).toEqual([{ field: "status", direction: 1 }]);
    expect(byName.get("orders_cover")?.include).toEqual(["total", "email"]);
    // The partial predicate survives as the SQL text the executor puts back.
    expect(byName.get("orders_paid")?.partial).toBe(true);
    expect(byName.get("orders_paid")?.partialFilter).toMatchObject({
      sql: expect.stringContaining("status"),
    });
    expect(byName.get("orders_email_key")?.unique).toBe(true);
    // A primary key is this engine's protected class, and the server refuses to
    // drop it too (asserted below).
    expect(byName.get("orders_pkey")?.isShardKey).toBe(true);
    // Nothing is ever hidden here, whatever indisvalid says.
    expect(specs.every((spec) => !spec.hidden)).toBe(true);
  });

  it("collects usage, sizes and storage with a since it can defend", async () => {
    await seed.query(`SELECT count(*) FROM ${SCHEMA}.orders WHERE customer_id = 7`);
    const usage = await session.collector.collectUsage("postgres", `${SCHEMA}.orders`);
    expect(usage.length).toBeGreaterThan(0);
    // Per-node by construction: the host is the one we dialled, because there is
    // no server-name concept to read instead.
    expect(usage.every((stat) => stat.host.length > 0)).toBe(true);
    // A crash NULLs stats_reset rather than restamping it, so `since` falls back
    // to postmaster start — never empty.
    expect(usage.every((stat) => (stat.since ?? "").length > 0)).toBe(true);
    expect(usage.every((stat) => Number.isFinite(stat.ops))).toBe(true);

    const sizes = await session.collector.indexSizes("postgres", `${SCHEMA}.orders`);
    expect(Object.keys(sizes).length).toBeGreaterThanOrEqual(5);
    expect(Object.values(sizes).every((bytes) => bytes > 0)).toBe(true);

    const storage = await session.collector.collectionStorage("postgres", `${SCHEMA}.orders`);
    expect(storage.dataSizeBytes).toBeGreaterThan(0);
    expect(storage.docCount).toBeGreaterThan(0);
  });

  // Reading SQL text is the weakest part of this adapter, so the shape it
  // extracts is asserted against a statement a real server normalized.
  it("extracts a query shape from pg_stat_statements", async () => {
    await seed.execute("SELECT pg_stat_statements_reset()");
    for (const customer of [11, 12, 13]) {
      await seed.query(
        `SELECT * FROM ${SCHEMA}.orders WHERE customer_id = $1 AND status = $2
           ORDER BY created_at DESC LIMIT 10`,
        [customer, "paid"],
      );
    }
    await seed.query(`DELETE FROM ${SCHEMA}.orders WHERE created_at < now() - interval '399 days'`);

    const shapes = await session.collector.collectWorkload([
      { database: "postgres", collection: `${SCHEMA}.orders` },
    ]);
    const found = shapes.get(workloadKey("postgres", `${SCHEMA}.orders`)) ?? [];
    const shape = found.find((candidate) => candidate.equality.includes("customer_id"));
    expect(shape).toBeDefined();
    expect([...(shape?.equality ?? [])].sort()).toEqual(["customer_id", "status"]);
    expect(shape?.sort).toEqual([{ field: "created_at", direction: -1 }]);
    // A bigint column arrives as a string from the driver; this is the assertion
    // that the boundary coerces it, because a string count survives every
    // comparison and breaks the first addition.
    expect(typeof shape?.count).toBe("number");

    const patterns = await session.collector.collectDeletePatterns("postgres", `${SCHEMA}.orders`);
    expect(patterns.some((pattern) => pattern.field === "created_at")).toBe(true);
    // Normalization replaced the cutoff, so there is no retention number to
    // report — the case ports.ts models rather than a shortfall.
    expect(patterns.every((pattern) => pattern.medianRetentionSeconds === null)).toBe(true);
    expect(patterns.every((pattern) => typeof pattern.count === "number")).toBe(true);
  });

  it("answers the health probe and a node roster", async () => {
    const health = await session.collector.collectServerHealth();
    expect(health).not.toBeNull();
    expect(health?.collectionScans).toBeGreaterThanOrEqual(0);
    // shared_buffers, not resident memory — a real number either way.
    expect(health?.residentMb).toBeGreaterThan(0);

    const nodes = await session.collector.collectNodes();
    expect(nodes?.length).toBeGreaterThanOrEqual(1);
    expect(nodes?.[0]).toMatchObject({ role: "primary", state: "answered" });
  });

  // Hint syntax does not exist in core, so this is empty by engine rather than
  // by omission.
  it("reports no hinted indexes", async () => {
    expect(await session.collector.collectHintedIndexes("postgres", `${SCHEMA}.orders`)).toEqual(
      [],
    );
  });

  describe("the write surface", () => {
    it("refuses to hide, because the engine cannot", () => {
      const executor = session.executor(false);
      expect(() => executor.hide("postgres", `${SCHEMA}.orders`, "orders_cover")).toThrow(
        HideUnsupportedError,
      );
      expect(() => executor.unhide("postgres", `${SCHEMA}.orders`, "orders_cover")).toThrow(
        HideUnsupportedError,
      );
    });

    it("refuses every write on a read-only cluster", async () => {
      const executor = session.executor(true);
      await expect(executor.drop("postgres", `${SCHEMA}.orders`, "orders_cover")).rejects.toThrow(
        /read-only/,
      );
    });

    it("creates and drops concurrently, keeping DESC, INCLUDE and the predicate", async () => {
      const executor = session.executor(false);
      await executor.create(
        "postgres",
        `${SCHEMA}.orders`,
        { status: 1, created_at: -1 },
        { name: "int_created", include: ["total"] },
      );
      const specs = await session.collector.listIndexes("postgres", `${SCHEMA}.orders`);
      const made = specs.find((spec) => spec.name === "int_created");
      expect(made?.keys).toEqual([
        { field: "status", direction: 1 },
        { field: "created_at", direction: -1 },
      ]);
      expect(made?.include).toEqual(["total"]);

      await executor.drop("postgres", `${SCHEMA}.orders`, "int_created");
      const after = await session.collector.listIndexes("postgres", `${SCHEMA}.orders`);
      expect(after.some((spec) => spec.name === "int_created")).toBe(false);
      // IF EXISTS: the pre-flight is a moment earlier and a DBA can drop an index
      // in between, so a second drop is the outcome the caller wanted.
      await expect(
        executor.drop("postgres", `${SCHEMA}.orders`, "int_created"),
      ).resolves.toBeUndefined();
    }, 60_000);

    // The failure mode neither other engine has: a failed CREATE INDEX
    // CONCURRENTLY leaves an index the planner ignores and writes still
    // maintain, and nothing cleans it up.
    it("cleans up the invalid index a failed concurrent build leaves behind", async () => {
      const executor = session.executor(false);
      await expect(
        executor.create(
          "postgres",
          `${SCHEMA}.orders`,
          { status: 1 },
          { name: "int_dup", unique: true },
        ),
      ).rejects.toThrow();
      const left = await seed.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'int_dup'`,
        [SCHEMA],
      );
      expect(Number(left[0]?.n ?? -1)).toBe(0);
    }, 60_000);

    // The server's own refusal, which is a better message than anything the
    // executor would invent.
    it("cannot drop the index a constraint requires", async () => {
      await expect(
        session.executor(false).drop("postgres", `${SCHEMA}.orders`, "orders_pkey"),
      ).rejects.toThrow(/constraint/i);
    });
  });

  describe("privileges", () => {
    it("reports an admin string as ready and able to apply", async () => {
      const diagnosis = await postgresAdapter.diagnose(POSTGRES_URL as string, OVERRIDES);
      expect(diagnosis.reachable).toBe(true);
      expect(diagnosis.ready).toBe(true);
      expect(diagnosis.canApply).toBe(true);
      expect(diagnosis.databases).toContain("postgres");
    });

    it("reports an unreachable string as unreachable rather than throwing", async () => {
      const diagnosis = await postgresAdapter.diagnose(
        (POSTGRES_URL as string).replace(/:probe@/, ":wrong@"),
        OVERRIDES,
      );
      expect(diagnosis.reachable).toBe(false);
      expect(diagnosis.ready).toBe(false);
      expect(diagnosis.message).toMatch(/password|authenticat/i);
    });

    // The claim this engine's whole provisioning story rests on: the role it
    // creates can do the analysis and CANNOT read the data or change an index.
    // Both halves asserted, because only proving the first would leave the
    // promise unverified.
    it("provisions a role that analyses and cannot read or apply", async () => {
      const provisioned = await provisionPostgresScopedUser(POSTGRES_URL as string, OVERRIDES);
      expect(provisioned.username).toMatch(/^idx_/);
      const scoped = new PostgresConnection(provisioned.connectionString, OVERRIDES);
      try {
        await scoped.connect();
        const collector = await postgresAdapter.open(provisioned.connectionString, OVERRIDES);
        try {
          const specs = await collector.collector.listIndexes("postgres", `${SCHEMA}.orders`);
          expect(specs.length).toBeGreaterThan(0);
          const usage = await collector.collector.collectUsage("postgres", `${SCHEMA}.orders`);
          expect(usage.length).toBeGreaterThan(0);
        } finally {
          await collector.close();
        }
        await expect(scoped.query(`SELECT total FROM ${SCHEMA}.orders LIMIT 1`)).rejects.toThrow(
          /permission denied/i,
        );
        await expect(
          scoped.execute(`CREATE INDEX int_scoped ON ${SCHEMA}.orders (total)`),
        ).rejects.toThrow(/must be owner/i);

        // And the preflight says so rather than leaving it to be discovered: this
        // string is ready and cannot apply, which on this engine is the intended
        // shape rather than a misconfiguration.
        const diagnosis = await postgresAdapter.diagnose(provisioned.connectionString, OVERRIDES);
        expect(diagnosis.ready).toBe(true);
        expect(diagnosis.canApply).toBe(false);
        expect(diagnosis.missing).toContain("table_owner");
      } finally {
        await scoped.close();
        await seed.execute(`DROP ROLE IF EXISTS ${provisioned.username}`).catch(() => {});
      }
    }, 120_000);

    it("refuses to provision from a string that cannot create a role", async () => {
      const limited = `nolimit_${Date.now().toString(36)}`;
      await seed.execute(`CREATE ROLE ${limited} LOGIN PASSWORD 'p' NOCREATEROLE`);
      try {
        const asLimited = (POSTGRES_URL as string).replace(/\/\/[^@]+@/, `//${limited}:p@`);
        await expect(provisionPostgresScopedUser(asLimited, OVERRIDES)).rejects.toThrow(
          ProvisionDeniedError,
        );
      } finally {
        await seed.execute(`DROP ROLE IF EXISTS ${limited}`).catch(() => {});
      }
    }, 60_000);
  });
});

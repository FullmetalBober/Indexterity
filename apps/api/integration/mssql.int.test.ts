import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRedundantPrefix, parseStoredSpec, rebuildKeys, rebuildOptions } from "../src/analysis";
import { DatabaseInaccessibleError, type EngineSession, workloadKey } from "../src/engine/ports";
import { ProvisionDeniedError, SCOPED_USERNAME } from "../src/engine/provision";
import { detectEngine } from "../src/engine/registry";
import type { IndexSpec } from "../src/engine/types";
import { collectSnapshots, serializeSpec } from "../src/mongo/snapshots";
import { mssqlAdapter } from "../src/mssql/adapter";
import { MssqlIndexCollector } from "../src/mssql/collector";
import { withMssqlCredentials } from "../src/mssql/conn-string";
import { asNumber, MssqlConnection } from "../src/mssql/connection";
import { dropLoginStatements } from "../src/mssql/provision";

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

  // #204. The two halves of a covering index, against the catalog rather than
  // against a fixture: that sys.index_columns reports the INCLUDEd columns as
  // key_ordinal 0 rows (which the collector must keep out of the keys), and
  // that an undo built from the stored spec puts the covering back.
  it("reads INCLUDE columns and rebuilds them from the stored spec", async () => {
    const executor = session.executor(false);
    await seed.execute(
      `CREATE INDEX ix_covering ON [${DB}].dbo.orders(customer_id) INCLUDE (status, email)`,
    );

    const specs = await session.collector.listIndexes(DB, "dbo.orders");
    const covering = specs.find((spec) => spec.name === "ix_covering");
    expect(covering?.keys).toEqual([{ field: "customer_id", direction: 1 }]);
    expect(covering?.include).toEqual(["status", "email"]);

    // The index the redundancy rule would have called this one a prefix of. It
    // covers nothing ix_covering covers, so the drop must not be proposed.
    const wider = specs.find((spec) => spec.name === "ix_customer_status");
    expect(wider).toBeUndefined();
    await seed.execute(
      `CREATE INDEX ix_customer_status ON [${DB}].dbo.orders(customer_id, status)`,
    );
    const withWider = await session.collector.listIndexes(DB, "dbo.orders");
    const pair = {
      covering: withWider.find((spec) => spec.name === "ix_covering"),
      wider: withWider.find((spec) => spec.name === "ix_customer_status"),
    };
    expect(pair.covering && pair.wider && isRedundantPrefix(pair.covering, pair.wider)).toBe(false);

    // …and the same pair without the includes IS the redundancy the rule is for.
    expect(
      pair.covering &&
        pair.wider &&
        isRedundantPrefix({ ...pair.covering, include: undefined }, pair.wider),
    ).toBe(true);

    // The undo path: drop, then rebuild from exactly what was persisted.
    const stored = parseStoredSpec(serializeSpec(pair.covering as IndexSpec));
    expect(stored.include).toEqual(["status", "email"]);
    await executor.drop(DB, "dbo.orders", "ix_covering");
    await executor.create(
      DB,
      "dbo.orders",
      rebuildKeys(stored) as Record<string, 1 | -1>,
      rebuildOptions(stored),
    );
    const rebuilt = (await session.collector.listIndexes(DB, "dbo.orders")).find(
      (spec) => spec.name === "ix_covering",
    );
    expect(rebuilt?.keys).toEqual(covering?.keys);
    expect(rebuilt?.include).toEqual(["status", "email"]);

    await executor.drop(DB, "dbo.orders", "ix_covering");
    await executor.drop(DB, "dbo.orders", "ix_customer_status");
  });

  // #203. The contract provisioning has to keep: it creates precisely what
  // diagnose probes, so a cluster we provisioned always diagnoses clean — and
  // the login it creates cannot read a single customer row.
  it("provisions a scoped login that diagnoses clean and cannot read rows", async () => {
    const admin = await mssqlAdapter.diagnose(MSSQL_URL as string, OVERRIDES);
    expect(admin.canProvision).toBe(true);

    const provision = mssqlAdapter.provisionScopedUser;
    expect(provision).toBeDefined();
    // Deliberately through a string that NAMES an initial database: a
    // server-scoped GRANT is refused outside master (Msg 4621), so provisioning
    // has to reach master itself rather than inherit the caller's context.
    const scoped = await (provision as NonNullable<typeof provision>)(
      (MSSQL_URL as string).replace("localhost:1433", `localhost:1433/${DB}`),
      OVERRIDES,
    );
    try {
      expect(scoped.username).toBe(SCOPED_USERNAME);

      const diagnosis = await mssqlAdapter.diagnose(scoped.connectionString, OVERRIDES);
      expect(diagnosis.username, JSON.stringify(diagnosis)).toBe(scoped.username);
      expect(diagnosis.reachable).toBe(true);
      // Both of these are the point: the scoped login can analyze AND apply,
      // without anyone granting it anything by hand.
      expect(diagnosis.ready, JSON.stringify(diagnosis.missing)).toBe(true);
      expect(diagnosis.canApply, JSON.stringify(diagnosis.missing)).toBe(true);
      // …and it could not create another login of its own.
      expect(diagnosis.canProvision).toBe(false);

      // The whole trust story, enforced by the server rather than by us.
      const scopedConn = new MssqlConnection(scoped.connectionString, OVERRIDES);
      await scopedConn.connect();
      try {
        await expect(
          scopedConn.query(`SELECT TOP 1 email FROM [${DB}].dbo.orders`),
        ).rejects.toThrow(/SELECT permission was denied/i);
        // It can still do its job: the index catalog and the usage counters.
        const specs = await new MssqlIndexCollector(scopedConn).listIndexes(DB, "dbo.orders");
        expect(specs.map((spec) => spec.name)).toContain("ix_customer");
        const usage = await new MssqlIndexCollector(scopedConn).collectUsage(DB, "dbo.orders");
        expect(usage.length).toBeGreaterThan(0);
      } finally {
        await scopedConn.close().catch(() => {});
      }
    } finally {
      await removeScopedLogin();
    }
  });

  // The cleanup every provisioning test here shares, and it walks the instance
  // rather than naming this suite's database: provisioning creates a user in
  // EVERY user database, SQL Server refuses to drop a login while any of them
  // remain, and the fixed name turns one missed user into a suite that refuses
  // every later provision as a duplicate.
  async function removeScopedLogin(): Promise<void> {
    await seed
      .execute(dropLoginStatements(SCOPED_USERNAME, await seed.listDatabaseNames()))
      .catch(() => {});
  }

  // The guard the fixed name buys. Provisioning the same instance twice is
  // refused BY THE SERVER, which is what stops one database being connected
  // twice under two display names.
  it("refuses a second provision against an instance it already provisioned", async () => {
    const provision = mssqlAdapter.provisionScopedUser as NonNullable<
      typeof mssqlAdapter.provisionScopedUser
    >;
    const first = await provision(MSSQL_URL as string, OVERRIDES);
    try {
      await expect(provision(MSSQL_URL as string, OVERRIDES)).rejects.toThrow(
        /already has an Indexterity user/i,
      );
      // And the refusal left the first login alone. This is the half that would
      // break silently: the rollback on the way out of a failed provision drops
      // the login by name, so a duplicate that fell into it would revoke the
      // credentials the existing connection is running on.
      const still = new MssqlConnection(first.connectionString, OVERRIDES);
      try {
        await still.connect();
        await still.ping();
      } finally {
        await still.close().catch(() => {});
      }
    } finally {
      await removeScopedLogin();
    }
  });

  // #244. Provisioning is deliberately NOT narrowed to the observe selection, and
  // both halves of that decision are measured here rather than argued.
  //
  // The selection says what Indexterity looks at; it must not say what the login
  // MAY look at, or the setting would be editable in one direction only —
  // provisioning runs once, from an admin string that is never stored, so a login
  // granted where the selection pointed could never be given a database ticked
  // later. What that costs is the second half: a database created AFTER the login
  // has no user for it either, which is the gap the api refuses at the tick and the
  // collect steps over.
  it("grants the scoped login across the databases that exist, and not the ones created later", async () => {
    const before = `${DB}_before`;
    const after = `${DB}_after`;
    await seed.execute(`IF DB_ID('${before}') IS NOT NULL DROP DATABASE [${before}]`);
    await seed.execute(`IF DB_ID('${after}') IS NOT NULL DROP DATABASE [${after}]`);
    // Present at provisioning time, with a table so there is something to read.
    await seed.execute(`CREATE DATABASE [${before}]`);
    await seed.execute(
      `CREATE TABLE [${before}].dbo.widgets(id int CONSTRAINT pk_widgets PRIMARY KEY)`,
    );

    const provision = mssqlAdapter.provisionScopedUser as NonNullable<
      typeof mssqlAdapter.provisionScopedUser
    >;
    const scoped = await provision(MSSQL_URL as string, OVERRIDES);
    const scopedConn = new MssqlConnection(scoped.connectionString, OVERRIDES);
    try {
      await scopedConn.connect();
      const collector = new MssqlIndexCollector(scopedConn);

      // Granted here even though nothing said to observe it — that is the point of
      // the revert: ticking this database later is a checkbox, not a grant somebody
      // has to go and make on the instance.
      expect(await collector.listCollectionNames(before)).toContain("dbo.widgets");
      // …and still no access to a row, in any database.
      await expect(
        scopedConn.query(`SELECT TOP 1 id FROM [${before}].dbo.widgets`),
      ).rejects.toThrow(/SELECT permission was denied/i);

      // Created after the grants were made, so the login has no user in it. The
      // server lists it anyway — VIEW ANY DATABASE is granted to public — which is
      // why existence is not access and the api probes rather than trusting a name.
      await seed.execute(`CREATE DATABASE [${after}]`);
      expect(await scopedConn.listDatabaseNames()).toContain(after);
      await expect(collector.listCollectionNames(after)).rejects.toBeInstanceOf(
        DatabaseInaccessibleError,
      );
    } finally {
      await scopedConn.close().catch(() => {});
      // Before the databases go: the users mapped into them have to be dropped
      // while the databases still exist, or the login outlives both.
      await removeScopedLogin();
      for (const database of [before, after]) {
        await seed
          .execute(`IF DB_ID('${database}') IS NOT NULL DROP DATABASE [${database}]`)
          .catch(() => {});
      }
    }
  });

  // The other half of #203: credentials that cannot do the job are told so
  // BEFORE anything is created. ALTER ANY LOGIN alone is the interesting case —
  // it creates the login happily and then cannot grant it anything (Msg 4613),
  // which is why CONTROL SERVER is a check of its own.
  it("refuses to provision with credentials that can create a login but not grant", async () => {
    const weak = "idx_int_weak";
    // Through master explicitly: the seeding above ran `USE [DB]` on this
    // pooled connection, and a server-scoped GRANT anywhere but master is
    // Msg 4621 — the same trap provisioning itself has to avoid.
    await seed.execute(
      `EXEC master.sys.sp_executesql N'IF SUSER_ID(''${weak}'') IS NOT NULL DROP LOGIN [${weak}];
         CREATE LOGIN [${weak}] WITH PASSWORD = ''W3ak!Pass'', CHECK_POLICY = OFF;
         GRANT ALTER ANY LOGIN TO [${weak}];
         GRANT VIEW SERVER STATE TO [${weak}]'`,
    );
    const weakUrl = withMssqlCredentials(MSSQL_URL as string, weak, "W3ak!Pass");
    try {
      const diagnosis = await mssqlAdapter.diagnose(weakUrl, OVERRIDES);
      expect(diagnosis.canProvision).toBe(false);
      const provisionChecks = diagnosis.privileges.filter((check) => check.tier === "PROVISION");
      expect(provisionChecks.find((check) => check.key === "alterAnyLogin")?.granted).toBe(true);
      expect(provisionChecks.find((check) => check.key === "controlServer")?.granted).toBe(false);

      await expect(
        (mssqlAdapter.provisionScopedUser as NonNullable<typeof mssqlAdapter.provisionScopedUser>)(
          weakUrl,
          OVERRIDES,
        ),
      ).rejects.toBeInstanceOf(ProvisionDeniedError);
      // …and it left nothing behind: the half-created login is dropped on the
      // way out. Load-bearing now that the name is fixed — a leftover would not
      // merely be untidy, it would refuse every later provision on this server
      // as a duplicate.
      const leftovers = await seed.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sys.server_principals WHERE name = @scoped`,
        { scoped: SCOPED_USERNAME },
      );
      expect(asNumber(leftovers[0]?.n)).toBe(0);
    } finally {
      await seed
        .execute(
          `EXEC master.sys.sp_executesql N'IF SUSER_ID(''${weak}'') IS NOT NULL DROP LOGIN [${weak}]'`,
        )
        .catch(() => {});
    }
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

    // The seeded equality + in-memory sort arrives as a shape. Nothing about
    // exact counts or merged constants is asserted live: whether the two
    // literal variants merge depends on the plans the optimizer happened to
    // pick (auto-parameterization, seek vs scan), which varies across fresh
    // servers — CI proved it. Merge arithmetic is pinned by the unit tests;
    // this suite proves extraction against a real server.
    const sorted = shapes.find(
      (shape) => shape.sortedInMemory === true && shape.equality.includes("customer_id"),
    );
    expect(sorted, JSON.stringify(shapes)).toBeDefined();
    expect(sorted?.count).toBeGreaterThanOrEqual(1);
    expect(sorted?.sort).toEqual([{ field: "status", direction: -1 }]);
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

// #202. An Availability Group's readable secondaries keep their OWN
// sys.dm_db_index_usage_stats, so an index serving only secondary reads looks
// dead from the primary — the same blind spot mongo/members.ts exists to close.
// Skipped without MSSQL_AG_URL, which must point at the PRIMARY of a group
// whose replicas carry read-only routing URLs this process can dial. Locally,
// two nodes on a podman network with host-published ports:
//
//   podman network create agnet
//   for n in 1 2; do podman run -d --name ag$n --hostname ag$n --network agnet \
//     -p 1433$n:1433 -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Str0ng!Pass' \
//     mcr.microsoft.com/mssql/server:2022-latest; done
//   # enable hadr on both (mssql-conf set hadr.hadrenabled 1) and restart,
//   # exchange an endpoint certificate, then CREATE AVAILABILITY GROUP … WITH
//   # (CLUSTER_TYPE = NONE) with SECONDARY_ROLE(ALLOW_CONNECTIONS = ALL,
//   # READ_ONLY_ROUTING_URL = 'tcp://127.0.0.1:1433<n>') on each replica.
//
//   ALLOW_PRIVATE_CLUSTER_TARGETS=true \
//   MSSQL_AG_URL='mssql://sa:Str0ng!Pass@127.0.0.1:14331?trustservercertificate=true' \
//   MSSQL_AG_SECONDARY_URL='mssql://sa:Str0ng!Pass@127.0.0.1:14332?trustservercertificate=true' \
//     npm run test:int -w apps/api -- integration/mssql.int.test.ts
const AG_URL = process.env.MSSQL_AG_URL;
const AG_SECONDARY_URL = process.env.MSSQL_AG_SECONDARY_URL;
// Created inside whichever database the group already replicates, and dropped
// afterwards.
const TABLE = "indexterity_ag_orders";

describe.skipIf(AG_URL === undefined || AG_SECONDARY_URL === undefined)(
  "mssql adapter against an availability group",
  () => {
    let primarySeed: MssqlConnection;
    let secondarySeed: MssqlConnection;
    let agSession: EngineSession;
    let secondaryName: string;
    // A database the group actually replicates — the suite does not administer
    // the group, it reads through one. Adding a database to an AG needs a
    // backup path and a seeding grant that belong to whoever built it.
    let agDatabase: string;

    beforeAll(async () => {
      primarySeed = new MssqlConnection(AG_URL as string, OVERRIDES);
      await primarySeed.connect();
      // Read intent: a replica configured ALLOW_CONNECTIONS = READ_ONLY refuses
      // a plain connection outright (Msg 978).
      secondarySeed = new MssqlConnection(AG_SECONDARY_URL as string, OVERRIDES, {
        readOnlyIntent: true,
      });
      await secondarySeed.connect();
      secondaryName = (await secondarySeed.serverIdentity()).serverName;
      const replicated = await primarySeed.query<{ name: string }>(
        `SELECT TOP 1 database_name AS name FROM sys.availability_databases_cluster
         ORDER BY database_name`,
      );
      const found = replicated[0]?.name;
      if (found === undefined) {
        throw new Error(
          "MSSQL_AG_URL names a group with no databases in it — add one " +
            "(ALTER AVAILABILITY GROUP … ADD DATABASE) so a secondary has something to read",
        );
      }
      agDatabase = found;
      agSession = await mssqlAdapter.open(AG_URL as string, OVERRIDES);
    }, 120_000);

    afterAll(async () => {
      await agSession?.close();
      await primarySeed
        ?.execute(`DROP TABLE IF EXISTS [${agDatabase}].dbo.${TABLE}`)
        .catch(() => {});
      await primarySeed?.close().catch(() => {});
      await secondarySeed?.close().catch(() => {});
    });

    it("names every replica in the roster, each with the role it claims itself", async () => {
      const nodes = (await agSession.collector.collectNodes()) ?? [];
      const primary = nodes.find((node) => node.role === "primary");
      const secondary = nodes.find((node) => node.host === secondaryName);
      expect(primary, JSON.stringify(nodes)).toBeDefined();
      expect(primary?.state).toBe("answered");
      expect(secondary, JSON.stringify(nodes)).toBeDefined();
      expect(secondary?.role).toBe("secondary");
      expect(secondary?.state).toBe("answered");
    });

    // The whole point of the issue: reads served by the secondary are counted
    // by the secondary, and a collect that only asks the primary reports zero.
    it("collects the secondary's own usage counters", async () => {
      const table = `[${agDatabase}].dbo.${TABLE}`;
      // DDL on the primary arrives at the secondary through the group; nothing
      // here creates anything on the secondary itself, which is the point.
      await primarySeed.execute(
        `IF OBJECT_ID('${table}') IS NULL
           EXEC('CREATE TABLE ${table}(
                   id int IDENTITY CONSTRAINT pk_ag_orders PRIMARY KEY,
                   customer_id int NOT NULL);
                 CREATE INDEX ix_ag_customer ON ${table}(customer_id);
                 INSERT INTO ${table}(customer_id)
                   SELECT TOP 2000 ABS(CHECKSUM(NEWID())) % 200
                   FROM sys.all_columns a CROSS JOIN sys.all_columns b;')`,
      );
      // Synchronous commit hardens the log on the secondary; REDO applying it
      // to the readable copy is a moment behind, and it applies statement by
      // statement — waiting for the TABLE is not enough, the index arrives
      // after it. Wait for the whole shape rather than assuming either.
      let visible = 0;
      for (let attempt = 0; attempt < 40 && visible < 2; attempt += 1) {
        visible = await secondarySeed
          .query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM [${agDatabase}].sys.indexes
             WHERE object_id = OBJECT_ID('${table}')`,
          )
          .then((rows) => asNumber(rows[0]?.n))
          .catch(() => 0);
        if (visible < 2) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(visible, `${table} never became readable on ${secondaryName}`).toBeGreaterThan(1);

      // Reads the SECONDARY serves, and only the secondary.
      for (const customer of [42, 43, 44]) {
        await secondarySeed.query(
          `SELECT COUNT(*) AS n FROM ${table} WHERE customer_id = ${customer}`,
        );
      }

      const usage = await agSession.collector.collectUsage(agDatabase, `dbo.${TABLE}`);
      const hosts = new Set(usage.map((stat) => stat.host));
      expect(hosts.has(secondaryName), JSON.stringify(usage)).toBe(true);
      expect(hosts.size, JSON.stringify(usage)).toBeGreaterThan(1);
      // Every reading carries the member's OWN counter start, not the
      // primary's: the ops-went-backwards rule reads them per member.
      for (const stat of usage) expect(Date.parse(stat.since)).toBeGreaterThan(0);

      // WHICH index served those reads is the planner's business and not this
      // suite's (#207): the claim under test is that whatever the secondary
      // served, the secondary is the only member that counted it — and from the
      // primary alone that index reads as completely unused.
      const busy = usage.find((stat) => stat.host === secondaryName && stat.ops > 0);
      expect(busy, JSON.stringify(usage)).toBeDefined();
      const sameOnPrimary = usage.find(
        (stat) => stat.host !== secondaryName && stat.indexName === busy?.indexName,
      );
      expect(sameOnPrimary, JSON.stringify(usage)).toBeDefined();
      expect(sameOnPrimary?.ops).toBe(0);
    });
  },
);

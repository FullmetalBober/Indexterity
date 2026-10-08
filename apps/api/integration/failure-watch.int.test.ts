import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { present } from "../src/errors/at";
import { MongoIndexCollector } from "../src/mongo/collector";
import { MongoConnection } from "../src/mongo/connection";
import { MongoFailureWatch } from "../src/mongo/failure-watch";
import { MemberConnections } from "../src/mongo/members";
import { markerOf } from "../src/mongo/profiler";
import { scopedConnString } from "../src/mongo/provision";

// Indexterity turning a database's profiler on for the drops in flight, and
// giving it back (#596) — against a mongod with AUTHENTICATION ON, because the
// privilege is half the story: setting the level needs `enableProfiler`, and a
// role without it has to come back as a reason rather than an error.
//
// Skipped without MONGO_ADMIN_URL — locally:
//   podman run -d --name mongoint -p 27018:27017 \
//     -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=probe \
//     docker.io/library/mongo:7.0
//   MONGO_ADMIN_URL='mongodb://root:probe@127.0.0.1:27018' \
//     npm run test:int -w apps/api -- integration/failure-watch.int.test.ts
const MONGO_ADMIN_URL = process.env.MONGO_ADMIN_URL;

const DB = "indexterity_int_watch";
const COLL = "orders";
const NS = `${DB}.${COLL}`;
const OWNER = "int-cluster";
const WATCHER_ROLE = "indexterityIntWatcher";
const READER_ROLE = "indexterityIntWatchReader";
const WATCHER = "indexterity_int_watcher";
const READER = "indexterity_int_watch_reader";

// The privileges the watch and its readings use, from the engine role
// (mongo/provision.ts) — with and without the one this is about.
const READS = [
  { resource: { db: "", collection: "" }, actions: ["listIndexes", "collMod"] },
  { resource: { db: "", collection: "system.profile" }, actions: ["find"] },
];

describe.skipIf(MONGO_ADMIN_URL === undefined)("a failure watch on a real mongod", () => {
  let admin: MongoClient;
  const opened: MongoConnection[] = [];

  const connectAs = async (user: string): Promise<MongoConnection> => {
    const conn = new MongoConnection(
      scopedConnString(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"), user, "probe"),
    );
    await conn.connect();
    opened.push(conn);
    return conn;
  };
  const watchAs = async (user: string, now?: () => number) => {
    const conn = await connectAs(user);
    const members = new MemberConnections(
      conn,
      scopedConnString(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"), user, "probe"),
    );
    return { conn, watch: new MongoFailureWatch(conn, members, now) };
  };
  const settings = async () => admin.db(DB).command({ profile: -1 });
  const target = (beforeHide: boolean) => ({
    database: DB,
    collection: COLL,
    indexName: "status_1",
    beforeHide,
  });
  const reset = async () => {
    await admin.db(DB).command({ profile: 0, filter: "unset" });
    await admin
      .db(DB)
      .collection("system.profile")
      .drop()
      .catch(() => undefined);
  };

  beforeAll(async () => {
    admin = new MongoClient(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"));
    await admin.connect();
    await cleanup();
    await admin
      .db(DB)
      .collection(COLL)
      .insertMany(Array.from({ length: 20 }, (_, i) => ({ status: i % 4, n: i })));
    await admin.db(DB).collection(COLL).createIndex({ status: 1 }, { name: "status_1" });
    const adminDb = admin.db("admin");
    await adminDb.command({
      createRole: WATCHER_ROLE,
      privileges: [
        { ...READS[0], actions: [...(READS[0]?.actions ?? []), "enableProfiler"] },
        ...READS.slice(1),
      ],
      roles: [],
    });
    await adminDb.command({ createRole: READER_ROLE, privileges: READS, roles: [] });
    await adminDb.command({ createUser: WATCHER, pwd: "probe", roles: [WATCHER_ROLE] });
    await adminDb.command({ createUser: READER, pwd: "probe", roles: [READER_ROLE] });
  });

  afterAll(async () => {
    for (const conn of opened) await conn.close().catch(() => undefined);
    await cleanup();
    await admin.close();
  });

  async function cleanup(): Promise<void> {
    const adminDb = admin.db("admin");
    for (const user of [WATCHER, READER]) {
      await adminDb.command({ dropUser: user }).catch(() => undefined);
    }
    for (const role of [WATCHER_ROLE, READER_ROLE]) {
      await adminDb.command({ dropRole: role }).catch(() => undefined);
    }
    await admin
      .db(DB)
      .command({ profile: 0, filter: "unset" })
      .catch(() => undefined);
    await admin
      .db(DB)
      .dropDatabase()
      .catch(() => undefined);
  }

  it("turns the profiler on, records what the watch is for, and keeps the slow-query log", async () => {
    await reset();
    const { conn, watch } = await watchAs(WATCHER);
    const before = Date.now();
    const result = await watch.reconcile(OWNER, [target(true)], []);
    const state = result.get(DB);
    expect(state).toMatchObject({ kind: "WATCHED", ours: true });
    if (state?.kind !== "WATCHED") throw new Error("expected a watch");
    const since = state.since.get(NS) ?? 0;
    expect(since).toBeGreaterThanOrEqual(before);

    const now = await settings();
    expect(now.was).toBe(1);
    expect(markerOf(now.filter)).toMatchObject({
      owner: OWNER,
      prior: { level: 0, filter: null },
      watch: { [NS]: since },
      hints: { [NS]: ["status_1"] },
    });

    const coll = admin.db(DB).collection(COLL);
    // A fast success: not the watch's business, and not recorded.
    await coll.find({ status: 1 }).comment("fast-success").toArray();
    // A hint at the candidate, by name and by pattern — recorded, so the hide can
    // be refused before it breaks them.
    await coll.find({ status: 2 }).hint("status_1").comment("hinted-by-name").toArray();
    await coll.find({ status: 2 }).hint({ status: 1 }).comment("hinted-by-pattern").toArray();
    await coll.updateOne({ status: 3 }, { $set: { touched: true } }, { hint: "status_1" });
    // Slower than slowms: kept as the database kept it before — the clause that
    // stops the filter swallowing the slow-query log.
    await coll.find({ $where: "sleep(150) || true", n: 1 }).comment("slow").toArray();
    // And a failure: a hint at the index once hidden.
    await admin.db(DB).command({ collMod: COLL, index: { name: "status_1", hidden: true } });
    for (let i = 0; i < 3; i += 1) {
      await expect(coll.find({ status: 1 }).hint("status_1").toArray()).rejects.toThrow();
    }
    await admin.db(DB).command({ collMod: COLL, index: { name: "status_1", hidden: false } });

    const ring = await admin.db(DB).collection("system.profile").find({ ns: NS }).toArray();
    const comments = ring.map((entry) => entry.command?.comment).filter((c) => c !== undefined);
    expect(comments).not.toContain("fast-success");
    expect(comments).toEqual(
      expect.arrayContaining(["hinted-by-name", "hinted-by-pattern", "slow"]),
    );

    // Slow-query log lines still written for the slow query.
    const log: unknown = (await admin.db("admin").command({ getLog: "global" })).log;
    const slowLogged =
      Array.isArray(log) &&
      log.some(
        (line) =>
          typeof line === "string" && line.includes('"Slow query"') && line.includes('"slow"'),
      );
    expect(slowLogged).toBe(true);

    // What the check reads: every failure, complete since the watch began — and
    // these three named the index in a hint, so they are the hide's (#625).
    const collector = new MongoIndexCollector(conn);
    expect(await collector.collectFailedOps(DB, COLL, since, "status_1")).toMatchObject({
      kind: "WINDOW",
      hinted: 3,
      suspect: 0,
      unrelated: [],
      blindSpot: null,
    });
    // And the hints, including the update's `{$hint: name}`.
    expect(await collector.collectHintedIndexes(DB, COLL)).toContain("status_1");
  });

  it("keeps a watch as it is, and gives back exactly what was there", async () => {
    await reset();
    const { watch } = await watchAs(WATCHER);
    await watch.reconcile(OWNER, [target(false)], []);
    const armed = await settings();
    // Nothing changed: the same filter, untouched.
    const again = await watch.reconcile(OWNER, [target(false)], []);
    expect(again.get(DB)).toMatchObject({ kind: "WATCHED", ours: true });
    expect((await settings()).filter).toEqual(armed.filter);

    const released = await watch.reconcile(OWNER, [], [DB]);
    expect(released.get(DB)).toEqual({ kind: "RELEASED", ours: false });
    const back = await settings();
    expect(back.was).toBe(0);
    expect(back.filter).toBeUndefined();
  });

  // A filter the database already had is the customer's: kept in force while the
  // watch runs, and put back exactly.
  it("keeps a filter the database already had, and restores it", async () => {
    await reset();
    await admin.db(DB).command({ profile: 1, filter: { millis: { $gte: 50 } } });
    const theirs = (await settings()).filter;
    const { watch } = await watchAs(WATCHER);
    await watch.reconcile(OWNER, [target(false)], []);
    const armed = await settings();
    expect(JSON.stringify(armed.filter)).toContain(JSON.stringify(theirs));
    await watch.reconcile(OWNER, [], [DB]);
    const back = await settings();
    expect(back.was).toBe(1);
    expect(back.filter).toEqual(theirs);
  });

  // setProfilingLevel(0) keeps the filter; a restart clears it. Level 0 with our
  // marker still there was a person, and is not overridden.
  it("does not fight a person who turned it off, and re-arms after a restart", async () => {
    await reset();
    const { watch } = await watchAs(WATCHER);
    await watch.reconcile(OWNER, [target(false)], []);
    await admin.db(DB).command({ profile: 0 });
    const declined = await watch.reconcile(OWNER, [target(false)], []);
    expect(declined.get(DB)).toEqual({
      kind: "UNWATCHED",
      reason: `the profiler on ${DB} was turned off after Indexterity turned it on`,
      ours: true,
    });
    expect((await settings()).was).toBe(0);

    // What a restart leaves: level 0, no filter — armed again, from now.
    await admin.db(DB).command({ profile: 0, filter: "unset" });
    const later = Date.now();
    const rearmed = await watch.reconcile(OWNER, [target(false)], []);
    const state = rearmed.get(DB);
    if (state?.kind !== "WATCHED") throw new Error("expected a watch");
    expect(state.since.get(NS)).toBeGreaterThanOrEqual(later);
    await watch.reconcile(OWNER, [], [DB]);
  });

  // The role is the opt-in: without the action, a reason the owner can act on.
  it("says why when the role may not turn the profiler on", async () => {
    await reset();
    const { watch } = await watchAs(READER);
    const result = await watch.reconcile(OWNER, [target(true)], []);
    expect(result.get(DB)).toEqual({
      kind: "UNWATCHED",
      reason: `Indexterity's user may not turn the profiler on for ${DB} (it needs the enableProfiler action)`,
      ours: false,
    });
    expect((await settings()).was).toBe(0);
  });

  // Two registrations of one cluster never take each other's watch for their own.
  it("leaves another registration's watch alone", async () => {
    await reset();
    const { watch } = await watchAs(WATCHER);
    await watch.reconcile("other-cluster", [target(false)], []);
    const theirs = await settings();
    const result = await watch.reconcile(OWNER, [target(false)], []);
    expect(result.get(DB)).toMatchObject({ kind: "UNWATCHED", ours: false });
    expect(await watch.reconcile(OWNER, [], [DB])).toEqual(
      new Map([[DB, { kind: "RELEASED", ours: false }]]),
    );
    expect((await settings()).filter).toEqual(theirs.filter);
    await watch.reconcile("other-cluster", [], [DB]);
  });

  // A database whose profiler records everything needs nothing turned on, and
  // nothing to wait out.
  it("leaves a profiler at level 2 alone", async () => {
    await reset();
    await admin.db(DB).command({ profile: 2 });
    const { watch } = await watchAs(WATCHER);
    const result = await watch.reconcile(OWNER, [target(true)], []);
    expect(result.get(DB)).toEqual({ kind: "WATCHED", since: new Map([[NS, 0]]), ours: false });
    const now = await settings();
    expect(now.was).toBe(2);
    expect(now.filter).toBeUndefined();
    await admin.db(DB).command({ profile: 0 });
  });
});

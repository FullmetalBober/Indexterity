import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, clusterBlocks, clusters, createDatabase, eq, organizations } from "../src/db";
import { markBlocked, markUnblocked } from "../src/jobs/blocked";
import { databaseUrl } from "./helpers";

// The one piece of hand-written SQL in the blocked-state feature, against a real
// postgres.
//
// `since` has to answer "for how long" without a read — two passes can land at
// once — so it is a CASE inside the upsert. Nothing in a unit test can tell
// whether that expression does what its comment claims; only postgres can.
//
// The grain is the PASS since #462, and the last two tests are the whole reason
// that changed: a probe that gets through must not clear a collect that has been
// failing for 19 hours, which is what the single-slot version did in production.
//
// No api and no mongo: this drives the two functions the worker calls.

let db: ReturnType<typeof createDatabase>;
let orgId: string;
let clusterId: string;

interface BlockState {
  reason: string;
  since: Date;
  detail: string;
}

// One pass's block, or null when that pass is running fine.
async function state(task: string): Promise<BlockState | null> {
  const [row] = await db
    .select({
      reason: clusterBlocks.reason,
      since: clusterBlocks.since,
      detail: clusterBlocks.detail,
    })
    .from(clusterBlocks)
    .where(and(eq(clusterBlocks.clusterId, clusterId), eq(clusterBlocks.task, task)));
  return row ?? null;
}

// Every pass currently blocked, so a test can say what the dashboard would show.
async function blockedTasks(): Promise<string[]> {
  const rows = await db
    .select({ task: clusterBlocks.task })
    .from(clusterBlocks)
    .where(eq(clusterBlocks.clusterId, clusterId));
  return rows.map((row) => row.task).sort();
}

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  const [org] = await db
    .insert(organizations)
    .values({ name: "blocked-state", slug: `blocked-${Date.now()}`, plan: "FREE" })
    .returning();
  if (org === undefined) throw new Error("could not create the fixture org");
  orgId = org.id;

  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "blocked-fixture",
      // Never dialled by this suite: the sealed halves only have to be non-null.
      sealedDek: Buffer.from("dek"),
      sealedData: Buffer.from("data"),
    })
    .returning();
  if (cluster === undefined) throw new Error("could not create the fixture cluster");
  clusterId = cluster.id;
});

afterAll(async () => {
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => {});
  await db.$client.end();
});

describe("recording why a cluster's pipeline stopped", () => {
  it("starts clear", async () => {
    expect(await blockedTasks()).toEqual([]);
  });

  it("records the reason, the sentence, and when it started", async () => {
    await markBlocked(
      db,
      clusterId,
      "collect",
      "UNREACHABLE",
      "connect ECONNREFUSED 10.0.0.4:27017",
    );

    const first = await state("collect");
    expect(first?.reason).toBe("UNREACHABLE");
    expect(first?.detail).toBe("connect ECONNREFUSED 10.0.0.4:27017");
    expect(first?.since).toBeInstanceOf(Date);
  });

  it("keeps the start time while the same condition continues", async () => {
    const before = await state("collect");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The next tick, and the one after: an owner needs "for six days", so a
    // repeat must not reset the clock.
    await markBlocked(db, clusterId, "collect", "UNREACHABLE", "connect ETIMEDOUT 10.0.0.4:27017");

    const after = await state("collect");
    expect(after?.since.getTime()).toBe(before?.since.getTime());
    // The sentence DOES move: it is the latest failure, not the first.
    expect(after?.detail).toBe("connect ETIMEDOUT 10.0.0.4:27017");
  });

  it("restarts the clock when that pass's condition itself changes", async () => {
    const before = await state("collect");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // A cluster that was unreachable and is now refusing TLS is a new condition,
    // not a continuation — "unreachable for six days" would be a lie about it.
    await markBlocked(
      db,
      clusterId,
      "collect",
      "INSECURE",
      "the stored string would connect in plaintext",
    );

    const after = await state("collect");
    expect(after?.reason).toBe("INSECURE");
    expect(after?.since.getTime() ?? 0).toBeGreaterThan(before?.since.getTime() ?? 0);
  });

  // #462. This used to overwrite: `blocked_task` was one column, so the later
  // pass won and the earlier condition was gone. Two passes fail for two reasons
  // and both are facts.
  it("holds one block per pass, each with its own clock", async () => {
    const collect = await state("collect");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await markBlocked(db, clusterId, "probe", "TIMED_OUT", "the probe pass ran past its budget");

    expect(await blockedTasks()).toEqual(["collect", "probe"]);
    const probe = await state("probe");
    expect(probe?.reason).toBe("TIMED_OUT");
    // The older condition keeps its own start time — which is the number the
    // dashboard sorts on, so "failing longest" stays answerable.
    expect(await state("collect")).toEqual(collect);
    expect(probe?.since.getTime() ?? 0).toBeGreaterThan(collect?.since.getTime() ?? 0);
  });

  // The fix, stated as the failure it replaces: in production a five-minute
  // probe kept succeeding beside a collect that had timed out for 19 hours, and
  // every success cleared the collect's row. The cluster read as healthy.
  it("clears only the pass that got through", async () => {
    await markUnblocked(db, clusterId, "probe");

    expect(await blockedTasks()).toEqual(["collect"]);
    expect(await state("collect")).not.toBeNull();
  });

  it("clears the last one too, leaving the cluster clean", async () => {
    await markUnblocked(db, clusterId, "collect");

    expect(await blockedTasks()).toEqual([]);
  });

  it("clearing a pass that is not blocked writes nothing", async () => {
    // The ordinary case, six passes per cluster per tick times the fleet: a
    // delete that matches nothing rather than an update rewriting the same
    // nulls and waking every replica for it.
    await markUnblocked(db, clusterId, "collect");

    expect(await blockedTasks()).toEqual([]);
  });
});

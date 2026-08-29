import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusters, createDatabase, eq, organizations } from "../src/db";
import { markBlocked, markUnblocked } from "../src/jobs/blocked";
import { databaseUrl } from "./helpers";

// The one piece of hand-written SQL in the blocked-state feature, against a real
// postgres.
//
// `blocked_since` has to answer "for how long" without a read — two passes can
// land at once — so it is a CASE inside the UPDATE. Nothing in a unit test can
// tell whether that expression does what its comment claims; only postgres can.
//
// No api and no mongo: this drives the two functions the worker calls.

let db: ReturnType<typeof createDatabase>;
let orgId: string;
let clusterId: string;

async function state(): Promise<{
  reason: string | null;
  since: Date | null;
  detail: string | null;
  task: string | null;
}> {
  const [row] = await db
    .select({
      reason: clusters.blockedReason,
      since: clusters.blockedSince,
      detail: clusters.blockedDetail,
      task: clusters.blockedTask,
    })
    .from(clusters)
    .where(eq(clusters.id, clusterId));
  if (row === undefined) throw new Error("the fixture cluster is gone");
  return row;
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
    expect(await state()).toEqual({ reason: null, since: null, detail: null, task: null });
  });

  it("records the reason, the sentence, and when it started", async () => {
    await markBlocked(
      db,
      clusterId,
      "collect",
      "UNREACHABLE",
      "connect ECONNREFUSED 10.0.0.4:27017",
    );

    const first = await state();
    expect(first.reason).toBe("UNREACHABLE");
    expect(first.detail).toBe("connect ECONNREFUSED 10.0.0.4:27017");
    expect(first.since).toBeInstanceOf(Date);
    expect(first.task).toBe("collect");
  });

  it("keeps the start time while the same condition continues", async () => {
    const before = await state();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The next tick, and the one after: an owner needs "for six days", so a
    // repeat must not reset the clock.
    await markBlocked(db, clusterId, "collect", "UNREACHABLE", "connect ETIMEDOUT 10.0.0.4:27017");

    const after = await state();
    expect(after.since?.getTime()).toBe(before.since?.getTime());
    // The sentence DOES move: it is the latest failure, not the first.
    expect(after.detail).toBe("connect ETIMEDOUT 10.0.0.4:27017");
  });

  // The pass follows the sentence rather than the clock (#408). A cluster
  // nothing can dial fails every pass in turn, so the one worth naming is
  // whichever just tried — while `since` still answers "for how long", which is
  // a fact about the condition and not about the pass that noticed it.
  it("moves the pass under an unchanged reason, without restarting the clock", async () => {
    const before = await state();
    expect(before.task).toBe("collect");

    await markBlocked(db, clusterId, "suggest", "UNREACHABLE", "connect ETIMEDOUT 10.0.0.4:27017");

    const after = await state();
    expect(after.task).toBe("suggest");
    expect(after.reason).toBe("UNREACHABLE");
    expect(after.since?.getTime()).toBe(before.since?.getTime());
  });

  it("restarts the clock when the condition itself changes", async () => {
    const before = await state();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // A cluster that was unreachable and is now refusing TLS is a new condition,
    // not a continuation — "unreachable for six days" would be a lie about it.
    await markBlocked(
      db,
      clusterId,
      "suggest",
      "INSECURE",
      "the stored string would connect in plaintext",
    );

    const after = await state();
    expect(after.reason).toBe("INSECURE");
    expect(after.task).toBe("suggest");
    expect(after.since?.getTime() ?? 0).toBeGreaterThan(before.since?.getTime() ?? 0);
  });

  it("clears on a pass that got through", async () => {
    await markUnblocked(db, clusterId);

    expect(await state()).toEqual({ reason: null, since: null, detail: null, task: null });
  });

  it("clearing a cluster that is not blocked writes nothing", async () => {
    // The ordinary case, six passes per cluster per tick times the fleet: the
    // guard is what keeps that from being an UPDATE that rewrites three nulls
    // and wakes every replica for it.
    await markUnblocked(db, clusterId);

    expect(await state()).toEqual({ reason: null, since: null, detail: null, task: null });
  });
});

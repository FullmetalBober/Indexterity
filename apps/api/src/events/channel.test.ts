import { describe, expect, it } from "vitest";
import { parseClusterEventNotification, toClusterEvent } from "./channel";
import { type EventNotifier, emitClusterEvent, emitPassFinished } from "./emit";

// Variant and version nibbles matter: zod 4's z.uuid() refuses an id whose
// variant bits are not RFC 9562, so the fixture has to be a real v4 shape.
const CLUSTER = "11111111-1111-4111-8111-111111111111";

describe("parseClusterEventNotification", () => {
  it("round-trips what emit sends", () => {
    const payload = JSON.stringify({ clusterId: CLUSTER, kind: "DROP_HIDDEN", task: null });
    expect(parseClusterEventNotification(payload)).toEqual({
      clusterId: CLUSTER,
      kind: "DROP_HIDDEN",
      task: null,
    });
  });

  // The channel name is not a secret. A stray writer must produce nothing, not
  // a crash in the listener that every SSE subscriber shares.
  it("answers null for anything that is not ours", () => {
    expect(parseClusterEventNotification("not json")).toBeNull();
    expect(parseClusterEventNotification('{"kind":"DROP_HIDDEN"}')).toBeNull();
    expect(
      parseClusterEventNotification(
        JSON.stringify({ clusterId: CLUSTER, kind: "SOMETHING_ELSE", task: null }),
      ),
    ).toBeNull();
    expect(
      parseClusterEventNotification(
        JSON.stringify({ clusterId: "not-a-uuid", kind: "DROP_HIDDEN", task: null }),
      ),
    ).toBeNull();
  });

  it("strips the routing id off the wire shape", () => {
    expect(toClusterEvent({ clusterId: CLUSTER, kind: "PASS_FINISHED", task: "collect" })).toEqual({
      kind: "PASS_FINISHED",
      task: "collect",
    });
  });
});

// No fake and no stub below this line.
//
// `EventNotifier` has one method, so the object each test writes IMPLEMENTS it —
// completely, not partially. Nothing is asserted away, because there is nothing
// left over to assert away: it is a second real implementation that records to
// an array instead of sending to postgres.
//
// These used to be `stub<Database>({ execute })`, which claimed a four-member
// drizzle client was standing there and was checked on none of it. The change
// that removed the claim was in the PRODUCTION code — emit depends on what it
// uses — and the test got honest as a side effect.
function recorder(fails = false): EventNotifier & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notify: async (payload) => {
      if (fails) throw new Error("connection refused");
      sent.push(payload);
    },
  };
}

describe("emitClusterEvent", () => {
  it("sends pg_notify on the shared channel", async () => {
    const notifier = recorder();
    await emitClusterEvent(notifier, { clusterId: CLUSTER, kind: "BUILD_GRADUATED", task: null });
    expect(notifier.sent).toHaveLength(1);
    // And the payload is the event, which the old fake could not see: it counted
    // calls to `execute` and never looked at the SQL those calls carried.
    expect(JSON.parse(notifier.sent[0] ?? "{}")).toEqual({
      clusterId: CLUSTER,
      kind: "BUILD_GRADUATED",
      task: null,
    });
  });

  // An emission is a nudge, never part of the pass: a failure here must not
  // turn a landed apply into a retried one that re-runs executor.hide.
  it("swallows a failed send", async () => {
    await expect(
      emitClusterEvent(recorder(true), { clusterId: CLUSTER, kind: "DROP_HIDDEN", task: null }),
    ).resolves.toBeUndefined();
  });
});

describe("emitPassFinished", () => {
  it("names the pass on the event", async () => {
    const notifier = recorder();
    await emitPassFinished(notifier, CLUSTER, "finalize");
    expect(JSON.parse(notifier.sent[0] ?? "{}")).toMatchObject({
      kind: "PASS_FINISHED",
      task: "finalize",
    });
  });

  // A task the contract's enum does not know is skipped rather than sent as an
  // event no client can interpret — the worker may grow tasks before the
  // contract does.
  it("skips a task the contract does not know", async () => {
    const notifier = recorder();
    await emitPassFinished(notifier, CLUSTER, "retention");
    expect(notifier.sent).toHaveLength(0);
  });
});

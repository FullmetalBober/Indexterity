import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db";
import { stub } from "../test-utils";
import { parseClusterEventNotification, toClusterEvent } from "./channel";
import { emitClusterEvent, emitPassFinished } from "./emit";

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

describe("emitClusterEvent", () => {
  it("sends pg_notify on the shared channel", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const db = stub<Database>({ execute });
    await emitClusterEvent(db, { clusterId: CLUSTER, kind: "BUILD_GRADUATED", task: null });
    expect(execute).toHaveBeenCalledOnce();
  });

  // An emission is a nudge, never part of the pass: a failure here must not
  // turn a landed apply into a retried one that re-runs executor.hide.
  it("swallows a failed send", async () => {
    const db = stub<Database>({
      execute: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    await expect(
      emitClusterEvent(db, { clusterId: CLUSTER, kind: "DROP_HIDDEN", task: null }),
    ).resolves.toBeUndefined();
  });
});

describe("emitPassFinished", () => {
  it("names the pass on the event", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const db = stub<Database>({ execute });
    await emitPassFinished(db, CLUSTER, "finalize");
    expect(execute).toHaveBeenCalledOnce();
  });

  // A task the contract's enum does not know is skipped rather than sent as an
  // event no client can interpret — the worker may grow tasks before the
  // contract does.
  it("skips a task the contract does not know", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const db = stub<Database>({ execute });
    await emitPassFinished(db, CLUSTER, "retention");
    expect(execute).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { FAILURE_BASELINE_MS } from "../analysis";
import { hideWaits } from "./recommendations.service";

const START = Date.parse("2026-10-17T10:00:00Z");

type Row = Parameters<typeof hideWaits>[0][number];
const row = (overrides: Partial<Row>): Row => ({
  id: "00000000-0000-4000-8000-000000000001",
  type: "DROP_UNUSED",
  state: "APPROVED",
  database: "app",
  collection: "orders",
  ...overrides,
});

const watch = (watching: boolean) => ({
  database: "app",
  starts: { "app.orders": START },
  watching,
});

// #642. Why an approved drop is not hidden yet, as apply's own gate reads it.
describe("hideWaits", () => {
  it("is the watch's start plus a day, for an approved drop", () => {
    expect(hideWaits([row({})], [watch(true)])).toEqual([
      {
        recommendationId: "00000000-0000-4000-8000-000000000001",
        hideableAt: new Date(START + FAILURE_BASELINE_MS).toISOString(),
      },
    ]);
  });

  // A watch the last pass did not find in place is one apply does not hold back
  // for, and a build or a drop already hidden waits on nothing here.
  it("says nothing where apply would not wait for the watch", () => {
    expect(hideWaits([row({})], [watch(false)])).toEqual([]);
    expect(hideWaits([row({ collection: "users" })], [watch(true)])).toEqual([]);
    expect(hideWaits([row({ state: "HIDDEN" })], [watch(true)])).toEqual([]);
    expect(hideWaits([row({ type: "CREATE" })], [watch(true)])).toEqual([]);
    expect(hideWaits([row({})], [])).toEqual([]);
  });
});

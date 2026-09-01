import { describe, expect, it } from "vitest";
import { MAX_GAP_HOURS } from "../analysis";
import { keysOf } from "../errors/at";
import { counterFingerprint, extendsRun, latencyFingerprint } from "./runs";

const HOUR_MS = 3_600_000;
const at = (hoursFromEpoch: number): Date =>
  new Date(Date.UTC(2026, 0, 1) + hoursFromEpoch * HOUR_MS);

describe("counterFingerprint", () => {
  it("is stable under member ordering", () => {
    // $indexStats is gathered per member and nothing promises the order holds.
    // If it did not sort, a re-ordered response would read as a changed counter
    // and every collect would write a row — undoing the whole change.
    const a = counterFingerprint([
      { member: "a", ops: 1, since: "x" },
      { member: "b", ops: 2, since: "y" },
    ]);
    const b = counterFingerprint([
      { member: "b", ops: 2, since: "y" },
      { member: "a", ops: 1, since: "x" },
    ]);
    expect(a).toBe(b);
  });

  it("separates a moved counter from a still one", () => {
    expect(counterFingerprint([{ member: "a", ops: 1 }])).not.toBe(
      counterFingerprint([{ member: "a", ops: 2 }]),
    );
  });

  it("separates a restart that left the op count alone", () => {
    // The counter reset to the same number it was on. Same ops, different
    // counter, and the run has to break — otherwise the restart disappears and
    // the trust gate never sees it.
    expect(counterFingerprint([{ member: "a", ops: 0, since: "2026-01-01T00:00:00Z" }])).not.toBe(
      counterFingerprint([{ member: "a", ops: 0, since: "2026-02-01T00:00:00Z" }]),
    );
  });

  it("separates a member appearing or leaving the set", () => {
    expect(counterFingerprint([{ member: "a", ops: 1 }])).not.toBe(
      counterFingerprint([
        { member: "a", ops: 1 },
        { member: "b", ops: 0 },
      ]),
    );
  });

  it("does not let two members be forged into one another's reading", () => {
    // Naive concatenation without a separator would make ("ab", 1) and
    // ("a", "b1") collide.
    expect(counterFingerprint([{ member: "ab", ops: 1 }])).not.toBe(
      counterFingerprint([{ member: "a", ops: 0 }]),
    );
  });
});

describe("latencyFingerprint", () => {
  const base = { readOps: 1, readLatencyMicros: 2, writeOps: 3, writeLatencyMicros: 4 };

  it("changes when any one of the four counters moves", () => {
    for (const key of keysOf(base)) {
      expect(latencyFingerprint({ ...base, [key]: base[key] + 1 })).not.toBe(
        latencyFingerprint(base),
      );
    }
  });
});

describe("extendsRun", () => {
  it("starts a run when there is nothing to extend", () => {
    expect(extendsRun(undefined, "state", at(0))).toBe(false);
  });

  it("extends an unchanged state seen again at the cadence", () => {
    expect(extendsRun({ fingerprint: "state", lastSeenAt: at(0) }, "state", at(6))).toBe(true);
  });

  it("starts a new run the moment the state differs", () => {
    expect(extendsRun({ fingerprint: "state", lastSeenAt: at(0) }, "other", at(6))).toBe(false);
  });

  // The rule that keeps the gap detection honest, and the one whose absence
  // would fail silently. The trust gate only inspects holes BETWEEN runs, so a
  // run allowed to swallow a fortnight of silence would present an unbroken
  // series and let a cluster nobody could reach certify its own indexes as
  // unused. Past the analysis layer's tolerance an identical reading is a
  // coincidence, not a continuation.
  it("refuses to extend across a hole the classifier would object to", () => {
    const current = { fingerprint: "state", lastSeenAt: at(0) };
    expect(extendsRun(current, "state", at(MAX_GAP_HOURS))).toBe(true);
    expect(extendsRun(current, "state", at(MAX_GAP_HOURS + 0.5))).toBe(false);
  });

  it("refuses a reading stamped before the run's own end", () => {
    // A clock stepping backwards. Extending would move lastSeenAt down and
    // shorten the interval the row asserts; a new row is at least true of itself.
    expect(extendsRun({ fingerprint: "state", lastSeenAt: at(6) }, "state", at(3))).toBe(false);
  });
});

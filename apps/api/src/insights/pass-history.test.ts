import { describe, expect, it } from "vitest";
import { passHistorySeries } from "./pass-history";

const at = (iso: string) => new Date(iso);

describe("passHistorySeries", () => {
  it("draws one series per pass, oldest hour first", () => {
    expect(
      passHistorySeries([
        { task: "finalize", hour: at("2026-10-10T08:00:00Z"), maxMs: 4_150_000 },
        { task: "collect", hour: at("2026-10-10T07:00:00Z"), maxMs: 41_000 },
        { task: "finalize", hour: at("2026-10-10T07:00:00Z"), maxMs: 27_000 },
      ]),
    ).toEqual([
      {
        task: "finalize",
        points: [
          { hour: "2026-10-10T07:00:00.000Z", maxMs: 27_000 },
          { hour: "2026-10-10T08:00:00.000Z", maxMs: 4_150_000 },
        ],
      },
      { task: "collect", points: [{ hour: "2026-10-10T07:00:00.000Z", maxMs: 41_000 }] },
    ]);
  });

  // A pass paced to every four hours is still one line.
  it("keeps a paced pass's line whole", () => {
    const [series] = passHistorySeries([
      { task: "suggest", hour: at("2026-10-10T00:00:00Z"), maxMs: 1_200_000 },
      { task: "suggest", hour: at("2026-10-10T04:00:00Z"), maxMs: 1_100_000 },
    ]);
    expect(series?.points.map((point) => point.maxMs)).toEqual([1_200_000, 1_100_000]);
  });

  // An outage is a break in the line, not a level nobody measured.
  it("breaks the line across a stretch longer than the slowest pace", () => {
    const [series] = passHistorySeries([
      { task: "collect", hour: at("2026-10-10T00:00:00Z"), maxMs: 40_000 },
      { task: "collect", hour: at("2026-10-10T09:00:00Z"), maxMs: 45_000 },
    ]);
    expect(series?.points).toEqual([
      { hour: "2026-10-10T00:00:00.000Z", maxMs: 40_000 },
      { hour: "2026-10-10T01:00:00.000Z", maxMs: null },
      { hour: "2026-10-10T09:00:00.000Z", maxMs: 45_000 },
    ]);
  });
});

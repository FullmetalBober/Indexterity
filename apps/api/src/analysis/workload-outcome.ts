import { type WorkloadOutcome, workloadOutcome } from "@repo/contracts";

// What the create side decided about one scanning query shape (#432).
//
// The companion to analysis/silence.ts, and the same argument one layer over:
// #277 gave the DROP side a way to say "we looked and declined", because an
// empty recommendations panel is indistinguishable from "your indexes are all
// fine". The create side had no equivalent at all. `jobs/suggest.ts` reads every
// scanning shape once an hour, prices it, and persists only what clears every
// gate — so a query walking 900k documents a week on a small collection was
// seen, judged, and never mentioned.
//
// Every gate is correct. Each exists so the engine does not propose an index
// nobody should build, and none of them is relaxed here. What changes is that
// the finding survives the proposal being declined, and says which gate
// declined it.
//
// The vocabulary lives in @repo/contracts because the page renders it; this file
// owns what each word MEANS to a reader, which is a fact about the pipeline and
// not something a browser should be composing. Same split as
// `explainSuppression` in analysis/silence.ts.

// What each outcome means, in the words the customer gets. One sentence each,
// and each one says what would have to change — a reader who disagrees with a
// gate needs to know which knob it is, not that a gate exists.
const EXPLANATIONS: Readonly<Record<WorkloadOutcome, string>> = {
  proposed:
    "An index for this shape is on the recommendations table — approve it there, or leave it and the next pass will re-derive it.",
  "below-cost-floor":
    "This collection's scanning costs less than a million documents a week, so no index was proposed for it. That threshold is about what an index would SAVE, not about whether the query is well written — a scan of a small collection is a page or two the server is holding anyway, and it is the same query that will hurt when the collection is larger.",
  "not-recurring":
    "Seen too few times, or too rarely, to be a workload: three sightings and a fortnightly rate are the floors. An index is maintained on every write for years, which a query that runs roughly never has not earned.",
  "ad-hoc-client":
    "Issued by what looks like a person at a prompt rather than by an application, so no index was built to serve it. If this is a scheduled job, giving its connection an appName is what makes it count.",
  cooldown:
    "The index this needs is parked — a previous attempt regressed, or an owner said no. The Parked panel on the overview says until when.",
  standing:
    "The index this needs is already the subject of a live recommendation, so it was not proposed twice. It may be waiting for your approval.",
  "index-exists":
    "An index on exactly these fields already exists. For a scan that means the planner chose not to use it, which another index would not fix; for an in-memory sort it means the existing index's key DIRECTIONS cannot serve the sort, and a second index differing only in direction doubles this collection's write cost — so it is raised for review rather than built.",
  "no-candidate":
    "This shape was read and no index could be derived from it — usually a query with no field that could lead an index's key.",
};

export function explainOutcome(outcome: WorkloadOutcome): string {
  return EXPLANATIONS[outcome];
}

// Parse an outcome the database holds.
//
// Null rather than a throw for unknown values, which is the reason the column is
// text at all: a row written by a newer worker than the api reading it must
// render as itself with no explanation, never fail the page it is on.
export function outcomeOf(value: string): WorkloadOutcome | null {
  const parsed = workloadOutcome.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// True for the outcomes that mean "nothing was proposed" — the page's own
// distinction, here so that adding an outcome forces a decision about which side
// of it the new one falls on.
export function isDeclined(outcome: WorkloadOutcome): boolean {
  return outcome !== "proposed";
}

import type { ClusterNodes } from "@repo/contracts";
import { instantOf } from "~/lib/instant";

// Reading a per-node usage split honestly (#161).
//
// `per_member` has always been collected on every member the cluster admits to,
// and every reader summed it before it reached the screen. The split is the
// finding: 40,000 ops all on one secondary is a reporting replica or an
// analytics client with a read preference, and dropping that index breaks
// something nobody was watching. The same 40,000 spread evenly is the
// application.
//
// The other half — and the reason this is a module rather than four lines in a
// cell — is that a per-node number which silently omits an unreachable secondary
// is WORSE than the total it replaced. "1 of 3 nodes" drawn on a cluster where
// two nodes were never asked is not a concentration finding; it is our blind
// spot rendered as the customer's.

// One member's reading, as either payload carries it. `since` is the member's
// counter start and is present only on the index inventory (#431) — the
// recommendation-scoped `IndexUsage` predates it, so it is optional here rather
// than nullable, and the two payloads share this module instead of forking the
// blind-spot rule.
export interface MemberReading {
  readonly member: string;
  readonly ops: number;
  readonly since?: string | null | undefined;
}

export interface UsageSplit {
  readonly totalOps: number;
  // Members that answered and reported this index, busiest first.
  readonly reporting: readonly MemberReading[];
  // How many of them recorded any operations at all. The numerator of "N of M".
  readonly activeCount: number;
  // Roster members whose usage is NOT in this reading — named, never counted as
  // zeroes. Two sources: a member the collect could not reach or was refused by
  // the net guard, and a member that answered but did not list this index.
  readonly blindSpots: readonly string[];
  // True when one member carries essentially all of it and there is more than
  // one member reporting. The finding, stated once so the cell and its tooltip
  // cannot disagree about it.
  readonly concentrated: boolean;
}

// A member carrying this much of the total is carrying it. Not 100%: a secondary
// serving a nightly report still picks up a handful of ops from a stray
// primary-preferred query, and a rule that only fires at exactly one member
// would miss the case it exists for.
const CONCENTRATION = 0.9;

// Structural rather than `IndexUsage`, so the index inventory's rows go through
// the same rule the recommendations table does. Widening this was the whole cost
// of not writing the blind-spot logic a second time (#431): both payloads carry
// a total and a list of members, and everything below reads only those.
export interface UsageReading {
  readonly totalOps: number;
  readonly perMember: readonly MemberReading[];
}

export function usageSplit(
  usage: UsageReading | undefined,
  roster: ClusterNodes | null,
): UsageSplit | null {
  if (usage === undefined) return null;
  const reporting = usage.perMember;
  const reported = new Set(reporting.map((entry) => entry.member));
  // Every member of the roster that this reading does not speak for. A roster we
  // do not have is not evidence of full coverage, so with no roster there is
  // nothing to subtract and nothing is claimed.
  const blindSpots = (roster?.nodes ?? [])
    .filter((node) => !reported.has(node.host))
    .map((node) => node.host);
  const busiest = reporting[0]?.ops ?? 0;
  return {
    totalOps: usage.totalOps,
    reporting,
    activeCount: reporting.filter((entry) => entry.ops > 0).length,
    blindSpots,
    concentrated:
      usage.totalOps > 0 && reporting.length > 1 && busiest >= usage.totalOps * CONCENTRATION,
  };
}

// The one-line form for the table cell.
//
// "2 of 3 nodes" counts members that recorded operations against members that
// ANSWERED — a ratio against the roster would fold a member we never reached
// into the same number as a member that reported zero, which is the confusion
// this whole thing exists to end. The blind spots get their own clause.
export function usageLine(split: UsageSplit): string {
  if (split.reporting.length === 0) return "no member reported this index";
  const nodes = `${split.activeCount} of ${split.reporting.length} node${
    split.reporting.length === 1 ? "" : "s"
  }`;
  return `${split.totalOps.toLocaleString()} ops · ${nodes}`;
}

// What the tooltip says, member by member, with the blind spots named at the end
// rather than left out.
// A member's counter start, when the reading carries one. Said in the tooltip
// rather than folded into the number, because it is what stops "0 ops" being
// read as idleness on a member that came up an hour ago (D114) — the counters
// are cumulative from `since` and nothing before it was ever counted.
function sinceClause(entry: MemberReading): string {
  const started = entry.since === undefined || entry.since === null ? null : instantOf(entry.since);
  return started === null ? "" : `, counting since ${started.toLocaleString()}`;
}

export function usageDetail(split: UsageSplit, observedAt: string): string[] {
  const lines = split.reporting.map(
    (entry) => `${entry.member} — ${entry.ops.toLocaleString()} ops${sinceClause(entry)}`,
  );
  for (const host of split.blindSpots) lines.push(`${host} — not reported by the last collect`);
  const observed = instantOf(observedAt);
  lines.push(observed === null ? "as of an unknown time" : `as of ${observed.toLocaleString()}`);
  return lines;
}

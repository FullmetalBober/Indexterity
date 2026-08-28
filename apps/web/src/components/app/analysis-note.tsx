import type { AnalysisNote } from "@repo/contracts";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { LocalTime } from "~/lib/local-time";

// Why the recommendations list is as short as it is (#277).
//
// An empty list is indistinguishable from "your indexes are all fine", and it is
// the wrong reading twice over. A cluster can be short of trustworthy usage
// history for any of seven reasons and receive no usage-based recommendation at
// all, with nothing saying which. And every collision guard in the engine works
// by making a finding disappear silently, so "nothing to suggest" and "we
// suggested it and hid it" looked the same from here.
//
// Drawn ABOVE the table on purpose: it is the sentence that tells a reader how to
// read what follows, and under the table it would be read after the conclusion it
// qualifies — or not at all, on a cluster with 500 rows.

// One decimal of honesty about staleness. The note is written by the classify
// pass, so it is at most one cadence old, and saying WHEN keeps that from
// reading as a live measurement.
const AT_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

function indexes(count: number): string {
  return count === 1 ? "1 index" : `${count} indexes`;
}

export function AnalysisNotePanel({ analysis }: { analysis: AnalysisNote | null }) {
  // No classify pass has explained itself yet. Nothing is the honest answer —
  // inventing "all clear" here is the exact failure this panel exists to fix,
  // one layer up (D19).
  if (analysis === null) return null;

  const { dominantRefusal, refusedIndexes, explanation, suppressed, usagePaused } = analysis;
  const showRefusal = dominantRefusal !== null && refusedIndexes > 0;
  if (!showRefusal && suppressed.length === 0) return null;

  return (
    <div className="mt-8 space-y-3">
      {showRefusal ? (
        // Paused is the state worth an alert: nothing at all cleared the gate, so
        // the usage half of this product is not running on this cluster. Partial
        // is ordinary — a cluster with new and old indexes always has some of
        // each — so it gets a quiet line rather than a box, which is what keeps
        // the box meaning something.
        usagePaused ? (
          <Alert>
            <AlertTitle>Usage-based recommendations are paused for this cluster</AlertTitle>
            <AlertDescription>
              <p>{explanation}</p>
              <p className="text-muted-foreground text-xs">
                {indexes(refusedIndexes)} affected, as of{" "}
                <LocalTime iso={analysis.decidedAt} options={AT_OPTIONS} />.
              </p>
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-muted-foreground text-sm">
            <span className="font-medium text-foreground">
              {indexes(refusedIndexes)} of {analysis.consideredIndexes} not yet usable for usage
              analysis
            </span>{" "}
            — {explanation}
          </p>
        )
      ) : null}

      {/* The suppression half. Counts rather than the findings themselves, which
          is enough for what it is for: a guard that has quietly become too broad
          shows up here as a number nobody can explain, where before it showed up
          as nothing at all. */}
      {suppressed.length > 0 ? (
        <ul className="space-y-1">
          {suppressed.map((entry) => (
            <li key={entry.guard} className="text-muted-foreground text-sm">
              {entry.explanation}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

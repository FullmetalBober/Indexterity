import { FAILURE_BASELINE_MS, type WatchedDatabase } from "@repo/contracts";
import { fmtDuration } from "~/components/app/passes-panel";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { millisOf } from "~/lib/instant";
import { PROFILER_RING_DOCS_HREF } from "~/lib/site";

// A watched database whose profiler ring holds less than a day (#642).
//
// The check after a hide compares failures against a day of records from before
// it, and what can be read of that day is what the ring still holds. Where it
// turns over sooner, a failure after the hide cannot be told from one that was
// already happening, so only a query naming the index in a hint can roll the hide
// back. On production, msb-app's 1 MB ring held about 47 minutes, and the only
// place that said so was inside each HIDE line, after the hide.
//
// Above the table, beside the analysis note, because it is about how to read the
// approved drops in it, and it is worth acting on before they are hidden.

// How much a ring held, said the way the ring is sized: to the minute.
function held(ms: number): string {
  return fmtDuration(Math.max(60_000, Math.round(ms / 60_000) * 60_000));
}

export function ShortProfilerNotice({ watched }: { watched: readonly WatchedDatabase[] }) {
  const short = watched.flatMap((watch) => {
    const checked = millisOf(watch.ringCheckedAt);
    const reach = millisOf(watch.ringReachAt);
    if (checked === null || reach === null) return [];
    const span = checked - reach;
    return span < FAILURE_BASELINE_MS ? [{ database: watch.database, span }] : [];
  });
  const [only] = short;
  if (only === undefined) return null;
  return (
    <Alert className="mt-8">
      <AlertTitle>
        {short.length === 1
          ? `The profiler on ${only.database} holds about ${held(only.span)} of history`
          : "Some profilers here hold less than a day of history"}
      </AlertTitle>
      <AlertDescription>
        {short.length === 1 ? null : (
          <ul className="list-disc pl-5">
            {short.map((entry) => (
              <li key={entry.database}>
                <span className="font-mono">{entry.database}</span>: about {held(entry.span)}
              </li>
            ))}
          </ul>
        )}
        <p>
          A hide is checked against a day of failed operations from before it. With less than a day
          to read, only a query that names the index in a hint can roll a hide back there.{" "}
          <a
            className="underline underline-offset-2"
            href={PROFILER_RING_DOCS_HREF}
            target="_blank"
            rel="noreferrer"
          >
            Make system.profile bigger
          </a>{" "}
          to give the check its day.
        </p>
      </AlertDescription>
    </Alert>
  );
}

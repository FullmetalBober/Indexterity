import type { ClusterCooldowns, ParkedIndex } from "@repo/contracts";
import { Truncated } from "~/components/truncated";
import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { LocalTime } from "~/lib/hydration";

// Indexes the engine has agreed not to propose again (#159).
//
// The engine's silence and the engine having nothing to say used to render
// identically: a cluster with six parked indexes looked exactly like a clean
// one. On a cluster that has been running a while the parked set is the most
// interesting thing about it — it is the list of decisions this product made and
// then backed out of.

// Day and month is enough for a date months out; the year appears when it is not
// this one, which for a 90-day veto set in November it will not be.
//
// The year test reads the UTC year on both sides so it cannot be the thing that
// differs — the DRAWING is what varies by reader, and LocalTime owns that.
function dayOptions(iso: string): Intl.DateTimeFormatOptions {
  const sameYear = new Date(iso).getUTCFullYear() === new Date().getUTCFullYear();
  return { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) };
}

// The number with no other home in the product. One regression is a rejected
// proposal; three is a fact about the collection, so it is said in words rather
// than left as a count nobody reads twice.
//
// Zero is not "never regressed" in the interesting sense — it is the owner
// paths, `recordManualVeto`, which set the count to 0 precisely because nothing
// regressed. The reason column already says which of the two it was, so this
// stays quiet rather than drawing a "0×" badge that would read as a measurement.
function regressionNote(count: number) {
  if (count === 0) return null;
  return <Badge variant={count > 1 ? "destructive" : "secondary"}>regressed {count}×</Badge>;
}

function ParkedRow({ entry }: { entry: ParkedIndex }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      {/* A collection-level park names no index, because there is no one index to
          name: several builds each passed their own check and together slowed the
          collection's writes (#282). Said in words rather than as a dangling
          separator after the namespace. */}
      <code className="font-mono text-xs">
        {entry.database}.{entry.collection}
        {entry.wholeCollection ? " · the whole collection" : ` · ${entry.indexName}`}
      </code>
      {regressionNote(entry.regressionCount)}
      <Truncated className="text-muted-foreground text-xs">{entry.reason}</Truncated>
      <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        {entry.active ? "until " : "eligible since "}
        <LocalTime iso={entry.until} options={dayOptions(entry.until)} dateOnly />
      </span>
    </li>
  );
}

export function ParkedPanel({
  cooldowns,
  loading,
}: {
  cooldowns: ClusterCooldowns;
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-16 w-full" />;

  const active = cooldowns.parked.filter((entry) => entry.active);
  const expired = cooldowns.parked.filter((entry) => !entry.active);

  if (cooldowns.parked.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing parked</EmptyTitle>
          <EmptyDescription>
            An index lands here when hiding it slowed reads, when a freshly built one slowed writes,
            or when an owner cancels or undoes a drop. Nothing parked means the engine has not had
            to back out of a decision on this cluster.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div>
      <p className="text-sm">
        <span className="font-medium">
          {/* The api's count, not `active.length` — same number, but the
              headline is the one field the server computed against its own
              clock, and reading it from the list is how the two start to
              disagree on a browser whose clock is behind. */}
          {cooldowns.activeCount === 0
            ? "Nothing parked right now"
            : `${cooldowns.activeCount} index${cooldowns.activeCount === 1 ? "" : "es"} parked`}
        </span>{" "}
        <span className="text-muted-foreground">
          {cooldowns.nextEligibleAt === null
            ? "— these have all come back into scope, and the engine may propose them again."
            : null}
          {cooldowns.nextEligibleAt === null ? null : (
            <>
              — next eligible{" "}
              <LocalTime
                iso={cooldowns.nextEligibleAt}
                options={dayOptions(cooldowns.nextEligibleAt)}
                dateOnly
              />
              . The engine will not propose these again until then.
            </>
          )}
        </span>
      </p>
      {active.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {active.map((entry) => (
            <ParkedRow
              key={`${entry.database}.${entry.collection}.${entry.indexName}`}
              entry={entry}
            />
          ))}
        </ul>
      ) : null}
      {/* Kept on screen rather than filtered out. A cooldown that has run out is
          the only record that this index was parked at all — the recommendation
          that caused it is long gone — and `regressed 3×` on an index the engine
          is now free to propose again is the sentence a reader most needs. */}
      {expired.length > 0 ? (
        <>
          <p className="mt-4 text-muted-foreground text-xs">
            Cooled down — back in scope, kept because how often an index has regressed is recorded
            nowhere else.
          </p>
          <ul className="mt-2 space-y-1 opacity-70">
            {expired.map((entry) => (
              <ParkedRow
                key={`${entry.database}.${entry.collection}.${entry.indexName}`}
                entry={entry}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

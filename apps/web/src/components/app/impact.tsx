import {
  BUILD_READ_WINDOW_DAYS,
  type BuildImpact,
  type ClusterRecommendations,
  type ClusterRoi,
  MIN_READS_TO_COMPARE,
} from "@repo/contracts";
import type { ReactNode } from "react";
import { DeltaCell, fmtBytes, fmtCount, fmtLatency } from "~/components/app/format";
import { UnavailableFigure } from "~/components/app/unavailable";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { LocalTime } from "~/lib/local-time";
import type { Read } from "~/lib/queries/read";

// The overview's headline figures (#608): what is open, what has been done.
//
// Each card answers from one read and waits or fails with it alone, so a dead
// ROI read costs the two cards drawn from it and nothing else (#289). A measured
// zero and an unknown look identical as a figure — "0 KB" reads as "we looked,
// there is nothing" — so a figure waits for its read, and a failed read shows no
// figure at all.

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function StatCard({
  label,
  read,
  figure,
  detail,
}: {
  label: string;
  read: Pick<Read<unknown>, "pending" | "failed" | "retry">;
  figure: () => ReactNode;
  detail: () => ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        {read.pending ? (
          <Skeleton className="h-9 w-32" />
        ) : read.failed ? (
          <UnavailableFigure onRetry={read.retry} />
        ) : (
          <CardTitle className="text-3xl tabular-nums">{figure()}</CardTitle>
        )}
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        {read.pending ? <Skeleton className="h-4 w-52" /> : read.failed ? null : detail()}
      </CardContent>
    </Card>
  );
}

// Waiting for review, and approved but not done: the two numbers an owner acts
// on differently, so they are never added into one.
function openLine(toReview: number, underWay: number, what: string): string {
  if (toReview === 0 && underWay === 0) return `No ${what}s open`;
  return `${plural(toReview, what)} to review · ${underWay.toLocaleString()} under way`;
}

// The scanning the measured builds took off the cluster: the documents a week
// their shapes examined at the build, less what the same shapes still examine.
// Null while no build has been measured — not zero, which would be a finding.
export function scanningRemoved(builds: readonly BuildImpact[]): number | null {
  let removed: number | null = null;
  for (const build of builds) {
    const since = build.scans?.since;
    if (build.scans === null || since === null || since === undefined) continue;
    removed =
      (removed ?? 0) + Math.max(0, build.scans.weeklyDocsExamined - since.weeklyDocsExamined);
  }
  return removed;
}

export function ImpactCards({
  recommendations,
  roi,
}: {
  recommendations: Read<ClusterRecommendations>;
  roi: Read<ClusterRoi>;
}) {
  const { drops, builds } = recommendations.data.summary;
  const removed = scanningRemoved(roi.data.builds);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* Every open drop, in every state, summed by the api: the rows on this
          page are capped, and the drops an owner has already approved wait in
          APPROVED and HIDDEN, which a PROPOSED-only sum never saw (#608). */}
      <StatCard
        label="Reclaimable"
        read={recommendations}
        figure={() => fmtBytes(drops.reclaimableBytes)}
        detail={() => openLine(drops.toReview, drops.underWay, "drop")}
      />
      <StatCard
        label="Reclaimed"
        read={roi}
        figure={() => fmtBytes(roi.data.freedBytes)}
        detail={() => `${plural(roi.data.indexesDropped, "index", "indexes")} dropped`}
      />
      <StatCard
        label="Built"
        read={roi}
        figure={() => roi.data.indexesBuilt.toLocaleString()}
        detail={() =>
          removed === null
            ? `${roi.data.indexesBuilt === 1 ? "index" : "indexes"} built and kept`
            : `${fmtCount(removed)} scanned docs/week removed`
        }
      />
      {/* The work the open builds are there to take off the cluster: what the
          scanning shapes they answer examine a week. */}
      <StatCard
        label="Scanning to fix"
        read={recommendations}
        figure={() => (
          <>
            {fmtCount(builds.weeklyDocsExamined)}
            <span className="ml-1 font-normal text-muted-foreground text-sm">docs/week</span>
          </>
        )}
        detail={() =>
          builds.scanningShapes === 0
            ? openLine(builds.toReview, builds.underWay, "build")
            : `${plural(builds.scanningShapes, "query shape")} · ${openLine(builds.toReview, builds.underWay, "build")}`
        }
      />
    </div>
  );
}

const BUILT_ON: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };

// Reads on the collection either side of the build, or why they cannot be
// compared. The percentage is withheld below the floor rather than drawn small:
// a number is a claim, and an average over thirty reads makes a loud one.
function ReadsLine({ build }: { build: BuildImpact }) {
  const { readsBefore: before, readsAfter: after } = build;
  if (
    before === null ||
    after === null ||
    before.ops < MIN_READS_TO_COMPARE ||
    after.ops < MIN_READS_TO_COMPARE
  ) {
    return (
      <span>
        Reads: too few to compare ({(before?.ops ?? 0).toLocaleString()} before,{" "}
        {(after?.ops ?? 0).toLocaleString()} after)
      </span>
    );
  }
  const pct = before.avgMicros === 0 ? null : (after.avgMicros / before.avgMicros - 1) * 100;
  const partial = build.afterDays < BUILD_READ_WINDOW_DAYS;
  return (
    <span>
      Reads {fmtLatency(before.avgMicros)} → {fmtLatency(after.avgMicros)} <DeltaCell pct={pct} />
      <span className="text-muted-foreground">
        {" "}
        · the week before against{" "}
        {partial
          ? `${plural(Math.max(1, Math.floor(build.afterDays)), "day")} after so far`
          : "the week after"}
      </span>
    </span>
  );
}

function ScansLine({ build }: { build: BuildImpact }) {
  const { scans } = build;
  if (scans === null) return null;
  const before = `${plural(scans.shapes, "query shape")} scanning ${fmtCount(scans.weeklyDocsExamined)} docs/week when built`;
  if (scans.since === null) return <span>{before}; checked a day after the build.</span>;
  if (scans.since.shapes === 0) return <span>{before}; none seen scanning since.</span>;
  return (
    <span>
      {before}; {scans.since.shapes} still scanning ({fmtCount(scans.since.weeklyDocsExamined)}{" "}
      docs/week).
    </span>
  );
}

// The other half of "Reclaimed by index": each index the engine built, and what
// it changed. No skeleton, for the same reason that card has none — a cluster
// with nothing built has no such panel at all.
export function BuiltByIndex({ builds, total }: { builds: readonly BuildImpact[]; total: number }) {
  if (builds.length === 0) return null;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Built by index</CardTitle>
        <CardDescription>
          Reads are the whole collection's, so a build that fixed one query of many moves them by
          that query's share.
          {total > builds.length ? ` The ${builds.length} most recent of ${total}.` : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-sm">
          {builds.map((build) => (
            <li key={build.recommendationId} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-xs">
                  {build.database}.{build.collection} · {build.indexName}
                </span>
                <span className="whitespace-nowrap text-muted-foreground text-xs">
                  built <LocalTime iso={build.builtAt} options={BUILT_ON} dateOnly />
                </span>
              </div>
              <div className="text-xs">
                <ReadsLine build={build} />
              </div>
              <div className="text-muted-foreground text-xs">
                <ScansLine build={build} />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

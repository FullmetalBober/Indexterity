import type { ClusterNodes, IndexUsage, Recommendation } from "@repo/contracts";
import { useMemo, useState } from "react";
import { badgeVariant, DropsOn, dropsOn } from "~/components/app/format";
import { type UsageSplit, usageDetail, usageLine, usageSplit } from "~/components/app/index-usage";
import { ConfirmButton } from "~/components/confirm-button";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Truncated } from "~/components/truncated";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { millisOf } from "~/lib/instant";
import {
  useApproveRecommendation,
  useRollbackRecommendation,
  useShortenObserveWindow,
  useUnhideRecommendation,
} from "~/lib/queries/mutations/recommendations";

const column = dashboardColumns<Recommendation>();

// Taken by id rather than as mutation objects: react-query's `mutate` keeps the
// same reference across renders, so the column list built from these stays stable
// and the row models are not rebuilt on every keystroke in the filter box.
interface Actions {
  readonly approve: (id: string) => void;
  // Carries the cancel dialog's answer: how many days to park the index, or null
  // for never (D136). It used to be a flat 90 the reader was told about in the
  // description and never asked about.
  readonly unhide: (input: { id: string; cooldownDays: number | null }) => void;
  readonly undo: (id: string) => void;
  readonly shorten: (id: string) => void;
}

// What each state offers to do about it, which is the column a reader came for.
// Advisories are the exception: the engine will not touch them at any setting, so
// the cell says so rather than offering a button that would not be honoured.
function action(rec: Recommendation, actions: Actions, readOnly: boolean) {
  if (rec.type === "ADVISORY_REVIEW") {
    return <span className="text-muted-foreground text-xs">review manually</span>;
  }
  // Same rule as the advisory above, for the same reason: a read-only cluster
  // never executes a write, so an approval here would sit at APPROVED forever
  // (#257). The api refuses it too — this is what stops a reader finding out
  // that way.
  if (rec.state === "PROPOSED" && readOnly) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="Switch the cluster to live in Settings"
      >
        read-only cluster
      </span>
    );
  }
  if (rec.state === "PROPOSED") {
    return (
      <ConfirmButton
        trigger={
          <Button size="sm" variant="secondary">
            Approve
          </Button>
        }
        title={`Approve ${rec.indexName}?`}
        description={
          <>
            <p>
              {rec.type === "REORDER"
                ? // The one approval that touches a constraint-bearing index, so
                  // it says what is preserved and in what order — a reader
                  // deciding this is owed more than "the index is built".
                  "The replacement is built FIRST, with the same keys and the same options — including the unique constraint, which both indexes then enforce. Only once it has survived its post-build watch is retiring the original proposed, through the usual hide, observe and regression gates. There is no moment when the constraint is not being enforced."
                : rec.type.startsWith("DROP") || rec.type === "MERGE"
                  ? "The index is hidden first and observed before anything is dropped — hiding is instant and reversible."
                  : "The index is built and then watched: if writes regress, the build rolls back automatically."}
            </p>
            <p className="font-mono text-xs">
              {rec.database}.{rec.collection} · {rec.indexName}
            </p>
          </>
        }
        confirmLabel="Approve"
        onConfirm={() => actions.approve(rec.id)}
      />
    );
  }
  if (rec.state === "DROPPED") {
    return (
      <ConfirmButton
        trigger={
          <Button size="sm" variant="outline">
            Undo
          </Button>
        }
        title={`Rebuild ${rec.indexName}?`}
        description="The index is recreated from the spec recorded at drop time, and the ROI headline is corrected back down."
        confirmLabel="Rebuild"
        onConfirm={() => actions.undo(rec.id)}
      />
    );
  }
  if (rec.state === "HIDDEN") return <HiddenActions rec={rec} actions={actions} />;
  return <span className="text-muted-foreground text-xs">{rec.state}</span>;
}

// The two controls a hidden drop offers, as a COMPONENT rather than a branch of
// `action` above, because cancelling now asks a question and the answer is state
// (D136). `action` is a plain function called from a cell renderer and cannot
// hold any.
function HiddenActions({ rec, actions }: { rec: Recommendation; actions: Actions }) {
  // The engine's proposal until the reader says otherwise, and it comes from the
  // api rather than being computed here — the curve is the engine's, and a
  // dashboard that reimplemented it would keep offering the old number the day it
  // moved.
  // Held as the TEXT in the box plus a flag, not as a number.
  //
  // A number cannot represent a half-typed answer, and the first version proved
  // why: it fell back to the proposal whenever the box parsed as NaN, so clearing
  // it to retype snapped 30 straight back and typing `7` gave 307. An empty box
  // is a reader mid-edit; it becomes a decision only on confirm.
  const [days, setDays] = useState(String(rec.proposedCooldownDays));
  const [forever, setForever] = useState(false);

  // What the box means when the reader presses the button. An unreadable or
  // non-positive answer takes the engine's proposal rather than refusing: they
  // asked to keep the index, and the parking is the detail.
  const parkFor = (): number | null => {
    if (forever) return null;
    const parsed = Number.parseInt(days, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : rec.proposedCooldownDays;
  };

  // The window is decided per index and frozen at hide time, so an owner who
  // already knows the index is dead otherwise has to wait out a cadence the
  // engine inferred — or cancel the drop, which re-proposes it later and
  // computes the very same window again (#270). Offered only while there is
  // something left to wait for: past the window the drop is already due and
  // ending the observation would do nothing.
  const waiting = dropsOn(rec);
  return (
    <div className="flex gap-1">
      <ConfirmButton
        trigger={
          <Button size="sm" variant="outline">
            Keep it
          </Button>
        }
        title={`Cancel the pending drop of ${rec.indexName}?`}
        description="The index becomes visible to the query planner again straight away. Choose how long the engine should leave it alone afterwards."
        confirmLabel="Un-hide"
        body={
          <CooldownChoice days={days} forever={forever} onDays={setDays} onForever={setForever} />
        }
        onConfirm={() => actions.unhide({ id: rec.id, cooldownDays: parkFor() })}
      />
      {waiting !== null && (millisOf(waiting) ?? 0) > Date.now() ? (
        <ConfirmButton
          trigger={
            <Button size="sm" variant="ghost">
              Drop sooner
            </Button>
          }
          title={`Stop observing ${rec.indexName}?`}
          description="The window is cut to the time this index has already been hidden, rounded up — so the drop becomes due within a day rather than at the end of its window. It still waits for the change window and still passes the regression gate: if hiding this index has slowed reads, it is un-hidden instead. Only the waiting is skipped."
          confirmLabel="End observation"
          onConfirm={() => actions.shorten(rec.id)}
        />
      ) : null}
    </div>
  );
}

// How long to leave the index alone: a number of days, or never.
//
// Two controls rather than a select of preset spans, because the two answers are
// different in kind. A duration is a guess the owner is refining — "give me a
// month, I will look again" — and never is a statement about the index: this one
// is load-bearing and the engine is wrong about it. A dropdown with `Never` as
// its last option reads as the longest duration, which is the one thing it is
// not.
function CooldownChoice({
  days,
  forever,
  onDays,
  onForever,
}: {
  days: string;
  forever: boolean;
  onDays: (next: string) => void;
  onForever: (next: boolean) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Label htmlFor="cooldown-days" className="text-sm">
          Leave it alone for
        </Label>
        <Input
          id="cooldown-days"
          type="number"
          min={1}
          max={3650}
          className="w-24"
          disabled={forever}
          // The raw text, so an empty box stays empty while it is retyped. What it
          // MEANS is resolved on confirm rather than on every keystroke.
          value={days}
          onChange={(event) => onDays(event.target.value)}
        />
        <span className="text-muted-foreground text-sm">days</span>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="cooldown-never"
          checked={forever}
          onCheckedChange={(checked) => onForever(checked === true)}
        />
        <Label htmlFor="cooldown-never" className="text-sm leading-snug">
          Never propose this index again
          <span className="block text-muted-foreground text-xs">
            Nothing expires it. Un-park it from the parked list when that changes.
          </span>
        </Label>
      </div>
    </div>
  );
}

// The per-node split, under the usage class it qualifies.
//
// Absent for an index the last collect did not see — no line at all rather than
// "0 ops on 0 nodes", which would be a measurement nobody took. A blind spot is
// named in the tooltip and counted in its own clause here, never folded into the
// node ratio: a member we could not reach and a member that reported zero are
// different facts, and telling them apart is the point of the whole thing.
function UsageSplitLine({ split }: { split: SplitEntry | undefined }) {
  if (split === undefined) return null;
  const { usage, detail } = split;
  const line = usageLine(usage);
  const blind = usage.blindSpots.length;
  return (
    <Truncated
      className={usage.concentrated ? "text-amber-700" : "text-muted-foreground"}
      full={
        <span className="block whitespace-pre-line">
          {usage.concentrated
            ? "Nearly all of this index's operations are on one member — it is likely serving a read-preference client rather than the application.\n\n"
            : ""}
          {detail.join("\n")}
        </span>
      }
    >
      {blind === 0 ? line : `${line} · ${blind} not reported`}
    </Truncated>
  );
}

function buildColumns(
  actions: Actions,
  splits: Map<string, SplitEntry>,
  readOnly: boolean,
): DashboardColumns<Recommendation> {
  // column.columns() rather than a bare array: it threads each column's own
  // value type out through a variadic tuple, so a string column and a number
  // column can sit in one list without both widening to unknown.
  return column.columns([
    column.accessor("type", {
      header: "Type",
      sortFn: "text",
      cell: (info) => <Badge variant={badgeVariant(info.getValue())}>{info.getValue()}</Badge>,
    }),
    // One accessor over both halves of the namespace, so sorting groups a
    // collection's indexes together instead of interleaving every database's.
    column.accessor((rec) => `${rec.database}.${rec.collection}`, {
      id: "namespace",
      header: "Collection",
      sortFn: "alphanumeric",
      // Still `title` rather than a tooltip, and that asymmetry with the column
      // beside it is a choice rather than an oversight: a namespace is scanned by
      // its tail as often as its head, so a clipped one usually still says which
      // collection it is. Worth revisiting together with collections-table, which
      // draws the same value the same way — moving one and not the other is how
      // two tables start disagreeing about what a hover does.
      cell: (info) => (
        <span className="block truncate font-mono text-xs" title={info.getValue()}>
          {info.getValue()}
        </span>
      ),
    }),
    column.accessor("indexName", {
      header: "Index",
      sortFn: "alphanumeric",
      // A clipped index name is worse than a clipped sentence: half of
      // `orders_customerId_1_createdAt_-1` names nothing, and it is the string a
      // reader carries to mongosh. Same treatment as the rationale.
      cell: (info) => <Truncated className="font-mono text-xs">{info.getValue()}</Truncated>,
    }),
    column.accessor("score", {
      header: "Score",
      sortFn: "basic",
      // Descending first: the reason to sort by confidence is to see the
      // strongest proposals, and a list of the weakest is nobody's first question.
      sortDescFirst: true,
      cell: (info) => {
        return (
          <span className="text-xs tabular-nums">
            {info.getValue()}
            {/* Once a drop is hidden the score is history — it decided whether to
                start, and the only open question is when this ends. The window is
                per-index, so it is not something a reader can work out from the
                policy setting. */}
            <DropsOn rec={info.row.original} />
          </span>
        );
      },
    }),
    // The class, and under it the split the class cannot express (#161). Sorted
    // by the class still: it is the categorical answer, and "which of these is
    // concentrated on one node" is a question you scan for rather than sort by.
    column.accessor((rec) => rec.usageClass ?? "—", {
      id: "usageClass",
      header: "Usage",
      sortFn: "text",
      cell: (info) => (
        <div className="text-xs">
          <span>{info.getValue()}</span>
          <UsageSplitLine split={splits.get(info.row.original.id)} />
        </div>
      ),
    }),
    column.accessor("rationale", {
      header: "Rationale",
      // Prose. Sorting it alphabetically orders nothing a reader is looking for.
      enableSorting: false,
      // The cell that outgrows its column. `columnWidths` clips every cell and the
      // primitive sets `whitespace-nowrap`, so a long rationale used to be cut off
      // mid-sentence with no ellipsis to say so and no way to read the rest — the
      // one column here where the text IS the answer.
      cell: (info) => <Truncated className="text-muted-foreground">{info.getValue()}</Truncated>,
    }),
    column.display({
      id: "action",
      header: "Action",
      cell: (info) => action(info.row.original, actions, readOnly),
    }),
  ]);
}

// Built once per payload rather than per cell: `usageSplit` walks the roster for
// every index, and the columns are memoized on it, so a fresh map each render
// would rebuild every row model on every keystroke in the filter box.
interface SplitEntry {
  readonly usage: UsageSplit;
  readonly detail: string[];
}

export function RecommendationsTable({
  clusterId,
  recommendations,
  // Both default to "nothing to say", which is a real state rather than a
  // convenience: a cluster whose roster read failed, or one collected before
  // per-member usage was surfaced, has no split to draw and must not have one
  // invented for it.
  usage = [],
  roster = null,
  total,
  loading,
  readOnly = false,
}: {
  clusterId: string | null;
  recommendations: Recommendation[];
  // Per-node usage for the rows above, beside them rather than on them — see the
  // contract's note on why the row shape does not carry it (#161).
  usage?: IndexUsage[];
  // The node roster from the same collect. It is what turns "3 members reported"
  // into "and these two did not", and the page has already fetched it for the
  // panel below. Null before it has answered: no roster is not evidence of full
  // coverage, so nothing is claimed until it arrives.
  roster?: ClusterNodes | null;
  // How many exist server-side; the api sends the RECOMMENDATIONS_CAP
  // highest-scoring of them (#64). Sorting and filtering below work over what
  // arrived — D33's client-side behaviour, deliberately kept — so when the
  // two numbers differ the table has to say so, or "no rows match" quietly
  // becomes a claim about rows that were never sent.
  total: number;
  loading: boolean;
  // The cluster's mode, so the Approve cell can say why it is not offering a
  // button. Defaulted rather than required: false is the state in which every
  // action is honoured, so a caller that forgets it gets the old behaviour and
  // the api's refusal, not a table that silently withholds approvals (#257).
  readOnly?: boolean;
}) {
  const approve = useApproveRecommendation(clusterId);
  const unhide = useUnhideRecommendation(clusterId);
  const undo = useRollbackRecommendation(clusterId);
  const shorten = useShortenObserveWindow(clusterId);

  const splits = useMemo(() => {
    const built = new Map<string, SplitEntry>();
    for (const entry of usage) {
      const split = usageSplit(entry, roster);
      if (split === null) continue;
      built.set(entry.recommendationId, {
        usage: split,
        detail: usageDetail(split, entry.observedAt),
      });
    }
    return built;
  }, [usage, roster]);

  const columns = useMemo(
    () =>
      buildColumns(
        {
          approve: approve.mutate,
          unhide: unhide.mutate,
          undo: undo.mutate,
          shorten: shorten.mutate,
        },
        splits,
        readOnly,
      ),
    [approve.mutate, unhide.mutate, undo.mutate, shorten.mutate, splits, readOnly],
  );

  const truncated = total > recommendations.length;

  return (
    <>
      {truncated ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Showing the {recommendations.length} highest-scoring of {total.toLocaleString()}{" "}
          recommendations. The filter searches these; the rest surface as they are resolved.
        </p>
      ) : null}
      <DataTable
        className="mt-6"
        caption="Index recommendations for this cluster"
        columns={columns}
        data={recommendations}
        loading={loading}
        getRowId={(rec) => rec.id}
        // Highest confidence first — the ordering a reader would apply by hand.
        initialSorting={[{ id: "score", desc: true }]}
        filterLabel="Filter recommendations"
        // Unbounded by nature: one row per index worth touching, across every
        // collection. Sixty-odd is a normal cluster and thousands is a big one.
        virtualize={{ maxHeight: 640, estimateRowHeight: 64 }}
        // Type, Collection, Index, Score, Usage, Rationale, Action. Rationale takes
        // the most because it is prose and wraps; the two names after it are the other
        // unpredictable ones. Fixing these is what stops the table re-laying itself out
        // as virtualized rows swap — see DataTable's columnWidths.
        //
        // Usage went from 120 to 176 when it gained the per-node line under the
        // class (#161): `40,000 ops · 1 of 3 nodes` does not fit in 120, and a
        // clipped one would hide exactly the half that is new.
        //
        // Action went from 132 to 200 when a hidden drop gained a second control
        // (#270). Cells at a fixed width are `overflow-hidden`, so the extra
        // button was not pushed off the table to be scrolled to — it was CUT, mid
        // word, which reads as a rendering fault rather than as a column that
        // needs more room. Two `sm` buttons and the gap between them are about
        // 160; the rest is the cell's own padding.
        columnWidths={[132, 200, 200, 104, 176, 280, 200]}
        // The rationale takes the slack, and takes all of it: the table fills the
        // page now, and the alternative to a long line is a clipped one. Past the
        // column's width the cell truncates and the tooltip carries the rest, so
        // the length of the line is no longer what decides whether it is readable.
        flexColumn={{ index: 5 }}
        empty={{
          title: "No recommendations yet",
          description:
            "The engine proposes changes once it has a week of index usage to reason about. Nothing to review means nothing is obviously wrong.",
        }}
      />
    </>
  );
}

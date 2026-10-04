import { Injectable } from "@nestjs/common";
import type {
  AnalysisNote,
  ClusterRecommendations,
  IndexUsage,
  Recommendation,
  SuppressionGuard,
} from "@repo/contracts";
import { RECOMMENDATIONS_CAP } from "@repo/contracts";
import {
  DEFAULT_OBSERVE_DAYS,
  dominantRefusal,
  explainRefusal,
  explainSuppression,
  parseStoredSpec,
  proposedVetoDays,
  rebuildKeys,
  rebuildOptions,
  SUPPRESSION_GUARDS,
  usageAnalysisPaused,
} from "../analysis";
import { DatabaseService } from "../db/database.service";
import type { CreateIndexOptions } from "../engine/ports";
import { mapClusterError, toRecommendation } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { CLASSIFY_OPTIONS } from "../jobs/classify";
import { openClusterSession } from "../jobs/cluster-connection";
import { recordManualVeto } from "../jobs/cooldowns";
import { type RecommendationRow, RecommendationsRepository } from "./recommendations.repository";

// How long a cancelled drop stays off the table before the engine may propose
// it again -- long enough that an owner is not re-rejecting the same row weekly.

// The refusals these use cases raise, taken as the handler's own error map
// rather than thrown as a bare ORPCError -- for the reason
// TenancyService.assertOwnsCluster gives next door: these codes are declared on
// the contract, and a refusal raised through the map is the one the client can
// discriminate.
type Refusals = {
  NOT_FOUND: (options: { message: string }) => Error;
  CONFLICT: (options: { message: string }) => Error;
};
type WindowRefusals = Refusals & {
  BAD_REQUEST: (options: { message: string }) => Error;
};

// The recommendations themselves and the three things a human can do to one:
// approve it, cancel it while it is hidden, or undo it after the drop.
//
// DatabaseService is injected for exactly two calls -- openClusterSession and
// recordManualVeto both take a database handle -- and for nothing else. Every
// query this feature issues is in the repository.
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
    private readonly repo: RecommendationsRepository,
  ) {}

  // Bounded (#64): the RECOMMENDATIONS_CAP highest-scoring rows plus the true
  // total. Measured before deciding: 4,000 proposals (the one-per-index worst
  // case) shipped 1.86 MB; the cap holds the payload near 250 KB however large
  // the cluster grows.
  async list(clusterId: string, orgId: string): Promise<ClusterRecommendations> {
    // Empty rather than NOT_FOUND, like the other per-cluster reads: the
    // dashboard asks for a cluster it has just been told about, and a refusal
    // there renders as a broken api rather than as an empty panel.
    if (!(await this.tenancy.ownsCluster(clusterId, orgId))) {
      return { clusterId, total: 0, recommendations: [], usage: [], analysis: null };
    }
    const total = await this.repo.countFor(clusterId);
    const rows = await this.repo.topFor(clusterId, RECOMMENDATIONS_CAP);
    return {
      clusterId,
      total: total ?? rows.length,
      recommendations: rows.map(toRecommendation),
      usage: await this.usageFor(clusterId, rows),
      analysis: await this.analysisFor(clusterId),
    };
  }

  async approve(id: string, orgId: string, errors: Refusals): Promise<Recommendation> {
    const owned = await this.repo.ownedForApproval(id, orgId);
    if (owned === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    // Approving is what puts a change into the apply pipeline, so it is the last
    // point at which "this database is not observed" can still be said in time.
    // Refused rather than silently dropped: the reader is looking at a row on
    // their screen, and a click that does nothing is worse than one that says
    // the list is stale.
    if (owned.observedDatabases !== null && !owned.observedDatabases.includes(owned.database)) {
      throw errors.CONFLICT({
        message:
          `${owned.database} is not one of the databases this cluster observes — ` +
          "reload the page, or add it back in the cluster's settings.",
      });
    }
    // Same reasoning, one step further out: a read-only cluster never executes a
    // write, so applyCluster returns before pre-flight and the row stays APPROVED
    // with no action, no event and nothing saying why (#257). Accepting the click
    // would be worse than the stale-list case above — that one resolves on a
    // reload, this one never resolves at all.
    if (owned.readOnly) {
      throw errors.CONFLICT({
        message:
          "this cluster is read-only, so nothing can be applied to it — " +
          "switch it to live in the cluster's settings first.",
      });
    }
    const row = await this.repo.setState(id, { state: "APPROVED" });
    if (row === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    return toRecommendation(row);
  }

  // Undo a drop: rebuild the index from the spec captured at drop time, correct
  // the ROI headline with a negative row, and mark the recommendation
  // ROLLED_BACK.
  async rollback(id: string, orgId: string, errors: Refusals): Promise<Recommendation> {
    const rec = await this.repo.ownedBy(id, orgId);
    if (rec === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    if (rec.state !== "DROPPED") {
      throw errors.CONFLICT({ message: "only a dropped index can be undone" });
    }
    const dropActions = await this.repo.dropActionsFor(rec.id);
    // A DROP row's token carries the spec; a CREATE row's carries a name
    // (db/schema.ts). That query asks for DROP rows only, so the `in` narrows the
    // union rather than guarding against something that happens — and it is
    // where a row written before the token existed drops out.
    const token = dropActions
      .map((action) => action.rollbackToken)
      .find((value) => value !== null && "spec" in value);
    if (token === undefined || token === null || !("spec" in token)) {
      throw errors.CONFLICT({ message: "no rollback token recorded for this drop" });
    }
    let keys: Record<string, 1 | -1> | null = null;
    // Everything the index WAS, not just its keys. An undo that restored a unique
    // index without its uniqueness would remove the constraint by putting it back
    // — see analysis/rollback.ts.
    let options: CreateIndexOptions = { name: rec.indexName };
    try {
      const spec = parseStoredSpec(token.spec);
      keys = rebuildKeys(spec);
      options = rebuildOptions(spec);
    } catch {
      keys = null;
    }
    if (keys === null) {
      throw errors.CONFLICT({ message: "stored spec cannot be rebuilt automatically" });
    }
    try {
      const { session, readOnly, release } = await openClusterSession(
        this.database.db,
        rec.clusterId,
      );
      try {
        if (readOnly) throw errors.CONFLICT({ message: "cluster is read-only" });
        await session.executor(readOnly).create(rec.database, rec.collection, keys, options);
      } finally {
        release();
      }
    } catch (error) {
      mapClusterError(error);
    }
    await this.repo.recordRollbackCorrection(rec);
    // Park it, exactly as cancelling a pending drop does. Without this the
    // rebuilt index goes straight back into the pipeline: it carries the same
    // name, so classify reads its pre-drop history, sees the same zero usage that
    // justified the drop in the first place, and proposes it again — and with
    // an autoApplyScore set, drops it again. Undo has to mean something for
    // longer than one classify tick.
    //
    // Not a regression, for the same reason as the cancel path: nothing got
    // slower, an owner simply knows something the engine does not.
    // The engine's default rather than a choice: undo is one click on a table
    // row and there is no dialog to answer. An owner who wants longer, or never,
    // says so from the parked list (D136).
    await this.veto(
      rec,
      "drop undone by an owner",
      proposedVetoDays(rec.observeDays ?? DEFAULT_OBSERVE_DAYS),
    );
    const updated = await this.repo.setState(rec.id, { state: "ROLLED_BACK" });
    if (updated === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    await this.repo.recordAction(rec.id, "ROLLBACK", "ok");
    return toRecommendation(updated);
  }

  // Cancel a pending drop while the index is still hidden.
  //
  // Until this existed the only ways out of HIDDEN were automatic — the
  // regression gate, a counter reset, a failed pre-flight — or disconnecting
  // the cluster. An owner who simply knew the index was needed had to wait out
  // the window.
  // `cooldownDays` is the owner's answer from the cancel dialog: a number of
  // days, or null for never (D136). Undefined means they did not choose, so the
  // engine's proposal stands — which is what an older client sends and what the
  // api must therefore keep meaning.
  async unhide(
    id: string,
    orgId: string,
    errors: Refusals,
    cooldownDays?: number | null,
  ): Promise<Recommendation> {
    const rec = await this.repo.ownedBy(id, orgId);
    if (rec === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    if (rec.state !== "HIDDEN") {
      throw errors.CONFLICT({ message: "only a hidden index can be un-hidden" });
    }
    try {
      const { session, readOnly, canHide, release } = await openClusterSession(
        this.database.db,
        rec.clusterId,
      );
      try {
        if (readOnly) throw errors.CONFLICT({ message: "cluster is read-only" });
        // On an engine with no reversible hide the index was never hidden, so
        // there is nothing to restore — but the rest of this is the valuable
        // half and still applies: the pending drop is cancelled and the index
        // vetoed, which is what the owner pressed the button for.
        if (canHide) {
          await session.executor(readOnly).unhide(rec.database, rec.collection, rec.indexName);
        }
      } finally {
        release();
      }
    } catch (error) {
      mapClusterError(error);
    }
    // Park it, so the next classify pass does not propose the same drop straight
    // back. Not counted as a regression — nothing regressed, an owner just
    // knows something the engine does not.
    const parkFor =
      cooldownDays === undefined
        ? proposedVetoDays(rec.observeDays ?? DEFAULT_OBSERVE_DAYS)
        : cooldownDays;
    const until = await this.veto(rec, "drop cancelled by an owner", parkFor);
    // "never" has no date to quote, and saying so is the point: an owner who
    // chose it should read it back rather than see a date far away.
    const day = until === null ? "never" : until.toISOString().slice(0, 10);
    const updated = await this.repo.setState(rec.id, {
      state: "REJECTED",
      hiddenAt: null,
      observeDays: null,
      observeReason: null,
      baselineReadOps: null,
      baselineReadLatency: null,
      rationale: `${rec.rationale} — cancelled by an owner; ${
        day === "never" ? "not to be re-proposed" : `not re-proposed until ${day}`
      }`,
    });
    if (updated === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    await this.repo.recordAction(
      rec.id,
      "HIDE",
      day === "never"
        ? "un-hidden on request; parked indefinitely"
        : `un-hidden on request; cooling down until ${day}`,
    );
    return toRecommendation(updated);
  }

  // Shorten a pending drop's observe window.
  //
  // The window is decided once at hide time and frozen deliberately —
  // recomputing it every pass would make the drop date walk as history rolled
  // out of retention, and a date nobody can plan around is worse than none. The
  // cost of that freeze is that an owner who knows an index is dead has no way to
  // say so: the only exit was to cancel the drop entirely, which re-proposes it
  // later and recomputes the very same window from the very same history. This is
  // that missing move, and it is the whole of it — the drop still waits for the
  // change window and still passes the regression gate, so what this shortens is
  // the OBSERVATION and never a safety step.
  async shortenObserveWindow(
    id: string,
    orgId: string,
    days: number | undefined,
    errors: WindowRefusals,
  ): Promise<Recommendation> {
    const rec = await this.repo.ownedBy(id, orgId);
    if (rec === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    if (rec.state !== "HIDDEN" || rec.hiddenAt === null) {
      throw errors.CONFLICT({ message: "only a hidden index has an observe window" });
    }
    const baseline = await this.repo.observeWindowBaseline(rec.clusterId);
    const current = rec.observeDays ?? baseline ?? DEFAULT_OBSERVE_DAYS;
    // The floor, and the default. Never into the past: a window shorter than the
    // time already served is due the moment it is written, so the next finalize
    // tick would drop the index with no interval in which anyone could change
    // their mind — "shorten" would quietly be spelled "drop now", which is a
    // different feature and a more dangerous one.
    const servedDays = Math.max(1, Math.ceil((Date.now() - rec.hiddenAt.getTime()) / 86_400_000));
    const wanted = days ?? servedDays;
    if (wanted >= current) {
      throw errors.BAD_REQUEST({
        message: `this drop is already observing for ${current} day(s) — a window can be shortened here, never lengthened`,
      });
    }
    if (wanted < servedDays) {
      throw errors.BAD_REQUEST({
        message: `this index has been hidden for ${servedDays} day(s); the window cannot be shortened below what it has already observed`,
      });
    }
    const updated = await this.repo.setState(rec.id, {
      observeDays: wanted,
      observeReason: `shortened to ${wanted} day(s) by an owner`,
    });
    if (updated === undefined) throw errors.NOT_FOUND({ message: "recommendation not found" });
    await this.repo.recordAction(
      rec.id,
      "HIDE",
      `observe window shortened from ${current} to ${wanted} day(s) on request`,
    );
    return toRecommendation(updated);
  }

  // `days` is the owner's answer, and null means never (D136). The caller
  // resolves the default — this only writes what it was told, so there is one
  // place that knows what "the engine proposes" means and it is not here.
  private veto(rec: RecommendationRow, reason: string, days: number | null): Promise<Date | null> {
    return recordManualVeto(
      this.database.db,
      rec.clusterId,
      { database: rec.database, collection: rec.collection, indexName: rec.indexName },
      days,
      reason,
    );
  }

  // Why the list is as short as it is (#277).
  //
  // Read from the note the last classify pass wrote rather than recomputed,
  // which is the trade #277 named: a column written per pass is stale by at most
  // one classify cadence, while recomputing is exact and costs the whole usage
  // history on every dashboard load. The stale answer is the right one here —
  // the reasons are conditions that persist for days, and `decidedAt` ships so
  // the dashboard can say when rather than implying "now".
  //
  // The SENTENCE is built here, not stored: every reason names a threshold from
  // CLASSIFY_OPTIONS, and copy stored at write time is copy that keeps quoting
  // "7 days" after the policy moved. Same reason the guard rationales are
  // composed rather than cached.
  private async analysisFor(clusterId: string): Promise<AnalysisNote | null> {
    const notes = await this.repo.analysisNotesFor(clusterId);
    if (notes.length === 0) return null;
    // The usage columns belong to the pass that has a usage gate. A producer
    // without one leaves them zero, and summing that in would report every
    // cluster as considering fewer indexes than it did.
    const usage = notes.find((row) => row.source === "CLASSIFY");
    const refusals = usage?.refusals ?? {};
    const dominant = dominantRefusal(refusals);
    // Only counted for the reason being reported. Summing every refusal would
    // read as "37 indexes are unanalysable" when the 37 are short of history for
    // four unrelated reasons, only one of which the sentence explains.
    const refusedIndexes = dominant === null ? 0 : (refusals[dominant] ?? 0);
    // The newest pass to have said anything, so the panel's "as of" is not older
    // than the reason beside it.
    const decidedAt = notes.reduce(
      (latest, row) => (row.decidedAt > latest ? row.decidedAt : latest),
      notes[0]?.decidedAt ?? new Date(0),
    );
    return {
      decidedAt: decidedAt.toISOString(),
      consideredIndexes: usage?.consideredIndexes ?? 0,
      trustedIndexes: usage?.trustedIndexes ?? 0,
      usagePaused: usageAnalysisPaused({
        consideredIndexes: usage?.consideredIndexes ?? 0,
        trustedIndexes: usage?.trustedIndexes ?? 0,
        refusals,
        suppressed: {},
      }),
      dominantRefusal: dominant,
      refusedIndexes,
      explanation: dominant === null ? null : explainRefusal(dominant, CLASSIFY_OPTIONS),
      // Iterated over the known guards rather than over the stored keys, so a key
      // an older api wrote and this one no longer understands is dropped instead
      // of reaching the contract and failing its own validation. Summed across
      // producers: a guard is a guard whoever tripped it, and two lines saying
      // "2 findings held back" would raise the question of what the difference
      // was.
      suppressed: SUPPRESSION_GUARDS.flatMap((guard: SuppressionGuard) => {
        const findings = notes.reduce((sum, row) => sum + (row.suppressed[guard] ?? 0), 0);
        return findings > 0
          ? [{ guard, findings, explanation: explainSuppression(guard, findings) }]
          : [];
      }),
    };
  }

  // Per-member usage for the indexes above (#161), from the last collect.
  //
  // `per_member` has been collected on every member the cluster admits to since
  // #99/#102 made member discovery real — and every reader summed it before it
  // reached the screen, so the whole point of collecting per member was spent on
  // making the total honest. An index whose 40,000 ops are all on one secondary
  // is serving a reporting replica; dropping it breaks something nobody was
  // watching. Spread evenly, the same 40,000 is the application. The engine's
  // usage class cannot tell them apart either.
  private async usageFor(
    clusterId: string,
    rows: readonly RecommendationRow[],
  ): Promise<IndexUsage[]> {
    if (rows.length === 0) return [];
    const snapshotRows = await this.repo.latestPerMemberUsage(clusterId);
    // One index name can have several dimension rows — a rebuild is keyed by
    // spec digest, so the identity outlives the shape (db/schema.ts). Newest
    // wins; they share `last_seen_at` here, so ties keep the first, which is the
    // one the collect wrote for the spec the index has now.
    const byNamespace = new Map<string, (typeof snapshotRows)[number]>();
    for (const row of snapshotRows) {
      const key = `${row.database}\u0000${row.collection}\u0000${row.indexName}`;
      const held = byNamespace.get(key);
      if (held === undefined || row.lastSeenAt > held.lastSeenAt) byNamespace.set(key, row);
    }
    return rows.flatMap((rec) => {
      const snapshot = byNamespace.get(
        `${rec.database}\u0000${rec.collection}\u0000${rec.indexName}`,
      );
      // No row rather than zeroes: the last collect did not see this index, and
      // "0 ops on 0 members" is a measurement nobody took.
      if (snapshot === undefined) return [];
      return [
        {
          recommendationId: rec.id,
          totalOps: snapshot.perMember.reduce((sum, member) => sum + member.ops, 0),
          // Busiest first, which is the order that makes concentration visible at
          // a glance — the reader is looking for one member carrying it all.
          perMember: [...snapshot.perMember]
            .map((member) => ({ member: member.member, ops: member.ops }))
            .sort((a, b) => b.ops - a.ops || a.member.localeCompare(b.member)),
          observedAt: snapshot.lastSeenAt.toISOString(),
        },
      ];
    });
  }
}

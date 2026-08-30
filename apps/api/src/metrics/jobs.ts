import type { WorkerEvents } from "graphile-worker";
import type { UsageTrustRefusal } from "../analysis/classify";
import type { ObservedVerdict } from "../analysis/observed";
import type { RegressionVerdict } from "../analysis/regression";
import {
  clustersUnreachable,
  clusterTaskRuns,
  indexDrops,
  jobDuration,
  jobRuns,
  regressionGate,
  usageTrustDecisions,
} from "./instruments";

// How a per-cluster tick ended. The pipeline already draws these distinctions
// (jobs/tasks.ts) — only "error" reaches graphile-worker as a failure, so
// without this counter the four handled conditions are invisible.
export type ClusterTaskOutcome =
  | "ok"
  | "unreachable"
  // The cluster's TUNNEL is down, which is a different fact from the cluster
  // being unreachable and is kept apart for the same reason "insecure" is: the
  // database may be perfectly healthy, and the thing to go and fix is a VPN
  // gateway. Folding it into "unreachable" would put a healthy cluster on the
  // unreachable gauge and send its owner hunting a firewall.
  | "tunnel-down"
  | "unsupported"
  | "credentials"
  // Stored string would not connect over validated TLS. Its own label rather
  // than "error": no retry fixes it, and it must not hide inside "unreachable",
  // where a cluster we are refusing to dial insecurely would read as a cluster
  // that is down.
  | "insecure"
  | "gone"
  // A read-only pass ran past its wall-clock budget and was abandoned (#407).
  // Its own label rather than "error" for the reason "insecure" has one: the
  // pass did not fail, it did not fit, and the operator's answer is a budget
  // rather than a bug. It is also the gauge that says whether the budget is set
  // somewhere sensible — a cluster reporting this every tick is one whose owner
  // is getting no recommendations at all.
  | "timed-out"
  | "error";

// Clusters whose last tick could not reach them. In memory and PER REPLICA,
// which was exactly sound while the pipeline was pinned to one process and is
// eventually consistent now that it is not (#232 lifted the cap): every
// replica drains from one shared queue, so a cluster's next task lands on an
// arbitrary pod and each pod's verdict for it refreshes within a few passes. A
// pod can therefore export a stale entry for a cluster another pod has since
// reached — bounded by how often the hourly passes go round — which is why the
// fleet alert is a ratio with a 15m hold rather than a zero-tolerance count.
const unreachable = new Set<string>();

export function recordClusterTask(
  task: string,
  clusterId: string,
  outcome: ClusterTaskOutcome,
): void {
  clusterTaskRuns.add(1, { task, outcome });
  // Reached and answered — including "your version is too old", which is an
  // answer, and "we refused to dial it", which is a verdict about the string
  // rather than about the cluster. An offboarded cluster leaves the set because
  // it no longer exists.
  if (
    outcome === "ok" ||
    outcome === "unsupported" ||
    outcome === "insecure" ||
    outcome === "gone"
  ) {
    unreachable.delete(clusterId);
  } else if (outcome === "unreachable") {
    unreachable.add(clusterId);
  }
  // "tunnel-down" deliberately touches neither: we did not reach the cluster,
  // so it cannot be marked reachable, and we never dialled it either, so it
  // has not been shown to be unreachable. The previous verdict stands, and the
  // tunnel's own health is where that condition is reported.
  // Undecryptable credentials and unexpected errors say nothing either way, so
  // they leave the previous verdict standing.
}

// Called by the dispatcher with every cluster it fanned out to. A cluster deleted
// while unreachable stops being ticked, so nothing would ever clear it — the
// fleet list is what says it is gone.
export function observeClusterFleet(clusterIds: readonly string[]): void {
  const fleet = new Set(clusterIds);
  for (const id of unreachable) {
    if (!fleet.has(id)) unreachable.delete(id);
  }
}

// What the gauge reports: clusters, not ticks. Exported so the decision above is
// testable without collecting a scrape.
export function unreachableClusterCount(): number {
  return unreachable.size;
}

// Test seam.
export function resetUnreachableClusters(): void {
  unreachable.clear();
}

export function recordRegressionVerdict(
  // "cumulative" is the collection-level reading (#282): the same measurement
  // against the oldest baseline still live for the collection, which is a
  // different question from either per-index stage and worth telling apart.
  stage: "observe" | "post_build" | "cumulative",
  // Two vocabularies, because the two gates now measure differently. The write
  // watch and the cumulative reading still difference a baseline the row carries
  // and report UNOBSERVABLE when a restart voids it; the observe gate reads
  // stored history instead (analysis/observed.ts), where a restart costs one
  // window and the states worth counting are "still accumulating" and "nothing
  // from before the hide to compare with". Folding them together would hide the
  // distinction the second gate exists to draw.
  verdict: RegressionVerdict | ObservedVerdict,
): void {
  regressionGate.add(1, { stage, verdict: verdict.toLowerCase() });
}

export function recordDrop(outcome: "dropped" | "unhidden" | "absent"): void {
  indexDrops.add(1, { outcome });
}

// One per index the classifier considered. `refusal` null means the history was
// trusted and a usage finding was possible; otherwise it is the check that said
// no.
//
// The `trigger` label went with `counters-reset`. It existed to tell the three
// ways of noticing a restart apart, which mattered while a restart refused the
// whole history; it segments the history now, so there is no refusal to break
// down and a label nobody can act on is one fewer series per engine to store.
export function recordUsageTrust(
  engine: string,
  refusal: UsageTrustRefusal | null,
  count = 1,
): void {
  if (count <= 0) return;
  usageTrustDecisions.add(count, { engine, outcome: refusal === null ? "trusted" : refusal.kind });
}

// Job-level counters from graphile-worker's own events, so the numbers agree with
// what the queue believes rather than with what a task remembered to report.
// Takes the EVENT STREAM rather than a Runner: the tick's drains (the only
// thing that executes jobs since #232) hand runOnce a long-lived emitter, and
// no Runner ever exists. Wired through wireRunnerEvents (jobs/runner.ts), which
// must be called ONCE per process — the gauge callback below would stack
// otherwise.
export function instrumentRunner(events: WorkerEvents): void {
  clustersUnreachable.addCallback((result) => result.observe(unreachableClusterCount()));

  events.on("job:success", ({ job }) => {
    jobRuns.add(1, { task: job.task_identifier, outcome: "success" });
    observeDuration(job);
  });
  // job:failed follows job:error when the last retry burns, on the same
  // condition, so an errored job is counted once: as a retry, or as
  // dead-lettered.
  events.on("job:error", ({ job }) => {
    if (job.attempts >= job.max_attempts) return;
    jobRuns.add(1, { task: job.task_identifier, outcome: "retry" });
    observeDuration(job);
  });
  events.on("job:failed", ({ job }) => {
    jobRuns.add(1, { task: job.task_identifier, outcome: "dead_letter" });
    observeDuration(job);
  });
}

// locked_at is when a worker claimed the job, which is where its execution
// starts — no need to hold a start time per job id.
function observeDuration(job: { task_identifier: string; locked_at: Date | null }): void {
  if (job.locked_at === null) return;
  const seconds = (Date.now() - job.locked_at.getTime()) / 1000;
  if (seconds < 0) return;
  jobDuration.record(seconds, { task: job.task_identifier });
}

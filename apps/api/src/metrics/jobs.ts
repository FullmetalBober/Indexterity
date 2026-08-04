import type { Runner } from "graphile-worker";
import {
  clustersUnreachable,
  clusterTaskRuns,
  indexDrops,
  jobDuration,
  jobRuns,
  regressionGate,
} from "./instruments";

// How a per-cluster tick ended. The pipeline already draws these distinctions
// (jobs/tasks.ts) — only "error" reaches graphile-worker as a failure, so
// without this counter the four handled conditions are invisible.
export type ClusterTaskOutcome =
  | "ok"
  | "unreachable"
  | "unsupported"
  | "credentials"
  | "gone"
  | "error";

// Clusters whose last tick could not reach them. In memory, which is sound for
// the same reason the alert cooldown is: the worker is a single replica by
// design, and with RUN_WORKER=true there is only the one process. It rebuilds
// itself within a tick of a restart.
const unreachable = new Set<string>();

export function recordClusterTask(
  task: string,
  clusterId: string,
  outcome: ClusterTaskOutcome,
): void {
  clusterTaskRuns.add(1, { task, outcome });
  // Reached and answered — including "your version is too old", which is an
  // answer. An offboarded cluster leaves the set because it no longer exists.
  if (outcome === "ok" || outcome === "unsupported" || outcome === "gone") {
    unreachable.delete(clusterId);
  } else if (outcome === "unreachable") {
    unreachable.add(clusterId);
  }
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
  stage: "observe" | "post_build",
  verdict: "REGRESSED" | "STABLE" | "UNOBSERVABLE",
): void {
  regressionGate.add(1, { stage, verdict: verdict.toLowerCase() });
}

export function recordDrop(outcome: "dropped" | "unhidden" | "absent"): void {
  indexDrops.add(1, { outcome });
}

// Job-level counters from graphile-worker's own events, so the numbers agree with
// what the queue believes rather than with what a task remembered to report.
// Wired inside startWorker, which covers the standalone worker and the
// RUN_WORKER=true api alike — and so does the unreachable gauge, which only the
// process that runs the pipeline can answer for.
export function instrumentRunner(runner: Runner): void {
  clustersUnreachable.addCallback((result) => result.observe(unreachableClusterCount()));

  runner.events.on("job:success", ({ job }) => {
    jobRuns.add(1, { task: job.task_identifier, outcome: "success" });
    observeDuration(job);
  });
  // job:failed follows job:error when the last retry burns, on the same
  // condition, so an errored job is counted once: as a retry, or as
  // dead-lettered.
  runner.events.on("job:error", ({ job }) => {
    if (job.attempts >= job.max_attempts) return;
    jobRuns.add(1, { task: job.task_identifier, outcome: "retry" });
    observeDuration(job);
  });
  runner.events.on("job:failed", ({ job }) => {
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

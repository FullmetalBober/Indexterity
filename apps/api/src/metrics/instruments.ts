import { ValueType } from "@opentelemetry/api";
import { meter } from "./provider";

// Every instrument the api and the worker record to, in one file. They come off
// the meter in provider.ts, which exists before this module is evaluated — see
// the note there for why that ordering is load-bearing.
//
// Names are OpenTelemetry names; the Prometheus exporter maps them by replacing
// `.` with `_` and appending `_total` to counters, so `indexterity.job.runs` is
// scraped as `indexterity_job_runs_total`. Durations carry `.seconds` in the name
// even though the unit already says so: this exporter writes the unit as a
// comment rather than into the name, and a Prometheus dashboard reads units off
// names.

// --- api: HTTP ------------------------------------------------------------
export const httpRequests = meter.createCounter("indexterity.http.requests", {
  description: "HTTP responses served, by route pattern and status.",
  valueType: ValueType.INT,
});

export const httpDuration = meter.createHistogram("indexterity.http.request.duration.seconds", {
  description: "Time to serve an HTTP request.",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10] },
});

// --- api: control-plane state --------------------------------------------
// Observable, not written as things change: these are facts about the database,
// the same for every replica, and reading them on collection means a label set
// that no longer exists (the last cluster of an engine disconnected, a task
// drained) stops being reported instead of freezing at its final value.
export const clustersConnected = meter.createObservableGauge("indexterity.clusters.connected", {
  description: "Clusters under management.",
  valueType: ValueType.INT,
});

// Every pipeline stage at once: PROPOSED is the approval backlog, HIDDEN the
// drops mid-observe, ACTIVE a build inside its post-build write watch.
export const recommendationStates = meter.createObservableGauge("indexterity.recommendations", {
  description: "Recommendations by pipeline state and type.",
  valueType: ValueType.INT,
});

// Queue depth per task, read from graphile-worker's own rows rather than counted
// in the worker: it survives a worker restart, and it is still reported when no
// worker is running at all — which is the case worth alerting on.
export const jobStates = meter.createObservableGauge("indexterity.jobs", {
  description:
    "Jobs in the queue by task and state (queued, scheduled, retrying, running, dead_letter).",
  valueType: ValueType.INT,
});

export const oldestQueuedJobAge = meter.createObservableGauge(
  "indexterity.jobs.oldest_queued_age.seconds",
  {
    description: "Age of the oldest runnable job no worker has claimed yet.",
    unit: "s",
  },
);

export const scrapeErrors = meter.createCounter("indexterity.metrics.scrape_errors", {
  description: "Collections where the control-plane gauges could not be read.",
  valueType: ValueType.INT,
});

// --- worker: jobs ---------------------------------------------------------
// dead_letter is the last retry burning, so its rate is the dead-letter rate.
export const jobRuns = meter.createCounter("indexterity.job.runs", {
  description: "Job executions by task and outcome (success, retry, dead_letter).",
  valueType: ValueType.INT,
});

export const jobDuration = meter.createHistogram("indexterity.job.duration.seconds", {
  description: "Time a job spent locked by a worker.",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 5, 15, 60, 300, 900] },
});

// --- worker: the data-plane pipeline --------------------------------------
// The classification jobs/tasks.ts already makes. Only "error" reaches
// graphile-worker as a failure, so without this counter the four handled
// conditions are invisible.
export const clusterTaskRuns = meter.createCounter("indexterity.cluster.task.runs", {
  description:
    "Per-cluster task ticks by outcome (ok, unreachable, unsupported, credentials, gone, error).",
  valueType: ValueType.INT,
});

export const clustersUnreachable = meter.createObservableGauge("indexterity.clusters.unreachable", {
  description: "Clusters whose last task tick could not reach them.",
  valueType: ValueType.INT,
});

export const regressionGate = meter.createCounter("indexterity.regression_gate.decisions", {
  description: "Regression gate decisions by stage (observe, post_build) and verdict.",
  valueType: ValueType.INT,
});

// The irreversible step, and the reversible ways it is refused.
export const indexDrops = meter.createCounter("indexterity.index.drops", {
  description: "Drop attempts that reached the end of the pipeline (dropped, unhidden, absent).",
  valueType: ValueType.INT,
});

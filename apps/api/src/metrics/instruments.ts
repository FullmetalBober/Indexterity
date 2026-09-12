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

// Why usage findings are or are not being made, per index considered.
//
// The gate that decides this refuses for eight different reasons and only ever
// said no (#267). "Recommendations are thin on this cluster" is not actionable
// without knowing which check is doing it, and the distribution is the input to
// deciding whether the counter-reset trigger is stricter than it needs to be now
// that usage is read as a difference (#265). Labelled by ENGINE because the
// answer is expected to differ: MSSQL's routine index-rebuild jobs trip the
// reset trigger in a way mongo's do not.
export const usageTrustDecisions = meter.createCounter("indexterity.usage_trust.decisions", {
  description:
    "Per-index usage-trust decisions by engine and outcome — `trusted`, or the check that refused.",
  valueType: ValueType.INT,
});

// The irreversible step, and the reversible ways it is refused.
export const indexDrops = meter.createCounter("indexterity.index.drops", {
  description: "Drop attempts that reached the end of the pipeline (dropped, unhidden, absent).",
  valueType: ValueType.INT,
});

// Whether run-length storage is still doing anything, per table and per engine.
//
// `index_snapshots` and `latency_samples` write ONE row per distinct counter
// state rather than one per collect, and the whole affordability argument for
// collecting hourly rests on that. It can stop working without anything failing:
// a reading that never repeats byte for byte folds nothing, and the tables go
// back to one row per collect with no error, no log line and no test.
//
// Which is not hypothetical — it is what #493 was. `latency_samples` folded at
// exactly 1.00x on both MongoDB clusters against 16.3x and 181.5x on the two SQL
// Server ones, because this product's own metadata reads moved the counters it
// was folding on. Sixteen days of production, and nothing said so; it took a
// dump and a spreadsheet.
//
// A COUNTER at write time, not a gauge over the tables. `sum(observations) /
// count(*)` is the same ratio and costs a full scan of a table projected at
// millions of rows, on every scrape — the exact cost D145 and D148 were about.
// The writer already knows both numbers per pass, so `rate(extended) /
// rate(extended + inserted)` is the fold rate over NEW evidence, which is the
// more useful question anyway: it answers "is folding working now" rather than
// "did it ever work".
//
// Labelled by engine because that is where the difference lives, and NOT by
// cluster: a label per cluster is unbounded cardinality, and one engine folding
// at zero is what an alert would fire on.
export const evidenceWrites = meter.createCounter("indexterity.evidence.writes", {
  description:
    "Run-length writes to the time-series tables by table, engine and outcome (`inserted` for a new state, `extended` for a repeated one).",
  valueType: ValueType.INT,
});

// --- api and worker: outbound mail ----------------------------------------
// Whether anything this product says ever leaves the building (#526).
//
// Every other way the pipeline can fail has a counter above it. Mail had none,
// and it is the one subsystem whose failure is indistinguishable from having
// nothing to say: a deployment with no SMTP, a transport refusing every send and
// a week where no cluster went wrong all produce exactly the same silence.
//
// `disabled` is counted rather than skipped, because it is not a non-event. It
// is the case `alertSettled` calls SETTLED — there is no transport, so no retry
// could do better — which is correct and also means the alert is gone. On an
// install where alerts are meant to work, half-configured SMTP is a fault, and
// this is the only number that says so.
//
// What this counter CANNOT see is a relay that accepts a message the receiver
// then rejects: `sendMail` resolves true when the transport took it, and on the
// hosted deploy that is Resend accepting under a `p=reject` DMARC policy whose
// only aligned authenticator is a single DKIM record. Those land in `sent`.
// Closing that needs a `rua=` reporting address at the sending domain, which is
// DNS and not code — #526 carries the record.
//
// Labelled by PURPOSE and not by recipient: the question worth alerting on is
// which channel died, and an address label is unbounded cardinality on the one
// counter most likely to be incremented by a stranger typing an email into a
// sign-up form.
export const mailSends = meter.createCounter("indexterity.mail.sends", {
  description:
    "Outbound mail send attempts by purpose (alert, digest, auth, invite) and outcome (`sent` when the transport accepted it, `refused` when it did not, `disabled` when there is no transport at all).",
  valueType: ValueType.INT,
});

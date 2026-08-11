// Pure decision: which failed jobs deserve an owner alert. Only per-cluster
// data-plane tasks, and only when the LAST retry just burned — transient
// failures retry silently.
const CLUSTER_TASKS = new Set(["collect", "classify", "suggest", "apply", "finalize"]);

export interface FailedJobInfo {
  readonly taskIdentifier: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly payload: unknown;
}

// Which cluster a job payload names, if it names one. Split out from the
// decision below because error reporting wants it for tasks the owner alert
// deliberately skips: a `retention` run that dies still happened somewhere, and
// the tag is worth having even when there is nobody to mail about it.
export function clusterIdOf(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "clusterId" in payload &&
    typeof payload.clusterId === "string"
  ) {
    return payload.clusterId;
  }
  return undefined;
}

export function finalClusterFailure(job: FailedJobInfo): string | null {
  if (job.attempts < job.maxAttempts) return null;
  if (!CLUSTER_TASKS.has(job.taskIdentifier)) return null;
  return clusterIdOf(job.payload) ?? null;
}

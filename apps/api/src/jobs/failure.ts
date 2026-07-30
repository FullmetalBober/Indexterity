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

export function finalClusterFailure(job: FailedJobInfo): string | null {
  if (job.attempts < job.maxAttempts) return null;
  if (!CLUSTER_TASKS.has(job.taskIdentifier)) return null;
  const payload = job.payload;
  if (
    typeof payload === "object" &&
    payload !== null &&
    "clusterId" in payload &&
    typeof payload.clusterId === "string"
  ) {
    return payload.clusterId;
  }
  return null;
}

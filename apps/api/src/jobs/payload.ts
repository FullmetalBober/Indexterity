// Narrow an untyped graphile-worker payload to a clusterId (no `as`).
export function clusterIdFromPayload(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "clusterId" in payload) {
    const value = payload.clusterId;
    if (typeof value === "string") return value;
  }
  throw new Error("job payload missing string clusterId");
}

// What the collector moves, hours apart: the latency summary, the series behind
// the charts, and the per-collection index footprint. No mutation touches it,
// which is why it is a key of its own — approving a recommendation used to
// refetch all three.
import type { CollectionLatencySeries, CollectionStat, LatencySummary } from "@repo/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

export const EMPTY_TELEMETRY = {
  latency: { collections: [] as LatencySummary[] },
  latencySeries: { collections: [] as CollectionLatencySeries[] },
  collectionStats: { collections: [] as CollectionStat[] },
};

type Telemetry = typeof EMPTY_TELEMETRY;

async function loadTelemetry(clusterId: string | null): Promise<Telemetry> {
  if (clusterId === null) return EMPTY_TELEMETRY;
  const client = api();
  try {
    const [latency, latencySeries, collectionStats] = await Promise.all([
      client.getLatency({ clusterId }),
      client.getLatencySeries({ clusterId }),
      client.getCollections({ clusterId }),
    ]);
    return { latency, latencySeries, collectionStats };
  } catch {
    return EMPTY_TELEMETRY;
  }
}

export function telemetryQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.telemetry(clusterId),
    queryFn: () => loadTelemetry(clusterId),
  });
}

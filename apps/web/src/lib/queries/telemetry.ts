// What the collector moves, hours apart: the latency summary, the series behind
// the charts, and the per-collection index footprint. No mutation touches it.
import { queryOptions } from "@tanstack/react-query";
import { loadTelemetry } from "../app-server";
import { queryKeys } from "./keys";

export function telemetryQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.telemetry(clusterId),
    queryFn: () => loadTelemetry({ data: clusterId }),
  });
}

export const EMPTY_TELEMETRY = {
  latency: { collections: [] },
  latencySeries: { collections: [] },
  collectionStats: { collections: [] },
};

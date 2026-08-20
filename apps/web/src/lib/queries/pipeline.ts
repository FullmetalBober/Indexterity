// The three reads a recommendation mutation moves: the proposals, the ROI
// headline and the audit trail.
//
// One query each. They were one entry behind a Promise.all because approving,
// undoing or un-hiding moves all three at once — but "these go stale together" is
// a fact about invalidation, and it is expressible as three invalidations. What
// the shared entry cost was on the read side: the ROI card could not be drawn
// without also fetching fifty recommendations and the whole trail.
import type {
  AuditAction,
  ClusterCooldowns,
  ClusterRecommendations,
  ClusterRoi,
} from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

// Stable fallbacks for a read that has NOTHING — see the note in telemetry.ts.
// Since #289 they no longer stand in for a read that FAILED: `Read.failed` says
// which of the two it was, and a panel that draws one of these while `failed` is
// set is making a claim it cannot support.
// The whole payload, not just the rows: `total` is what keeps the api's cap
// honest on screen (#64), so dropping it here would re-hide the truncation.
export const NO_RECOMMENDATIONS: ClusterRecommendations = {
  clusterId: "",
  total: 0,
  recommendations: [],
  usage: [],
  // Null, not an empty note: "no classify pass has explained itself yet" and
  // "the pass ran and had nothing to explain" are different states, and drawing
  // the second on a failed read would be inventing a reassurance (#277).
  analysis: null,
};
export const NO_ACTIVITY: AuditAction[] = [];
// A cluster with nothing dropped yet shows zeroes, which is honest: nothing has
// been proven. A cluster whose ROI read FAILED used to show the same zeroes,
// which was not — "$0.00/mo reclaimed" is a measurement, and none was taken
// (#289). The figure is now withheld instead; this stays the shape for the
// genuinely-empty case.
export const NO_ROI: ClusterRoi = {
  clusterId: "",
  freedBytes: 0,
  indexesDropped: 0,
  estimatedMonthlyUsd: 0,
  attribution: [],
};

// A cluster nobody has parked anything on. The failed read no longer shares this
// panel (#289): "Nothing parked means the engine has not had to back out of a
// decision on this cluster" is a claim about the engine, and a read that never
// answered supports no claim at all.
export const NO_COOLDOWNS: ClusterCooldowns = {
  clusterId: "",
  activeCount: 0,
  nextEligibleAt: null,
  parked: [],
};

export function recommendationsQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.recommendations(clusterId),
    queryFn: () =>
      clusterId === null ? NO_RECOMMENDATIONS : api().listRecommendations({ clusterId }),
  });
}

export function roiQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.roi(clusterId),
    queryFn: () => (clusterId === null ? NO_ROI : api().getRoi({ clusterId })),
  });
}

export function activityQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.activity(clusterId),
    queryFn: () => (clusterId === null ? NO_ACTIVITY : api().listActions({ clusterId })),
  });
}

// The whole payload: `activeCount` is the panel's headline and the list holds
// expired rows too, so the two numbers must not be conflated here (#159).
export function cooldownsQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.cooldowns(clusterId),
    queryFn: () => (clusterId === null ? NO_COOLDOWNS : api().listCooldowns({ clusterId })),
  });
}

// Each returns the payload AND whether this is the first fetch — see read.ts for
// why the bare payload was not enough.
export function useRecommendations(clusterId: string | null): Read<ClusterRecommendations> {
  const {
    data = NO_RECOMMENDATIONS,
    isPending,
    isError,
    refetch,
  } = useQuery(recommendationsQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useRoi(clusterId: string | null): Read<ClusterRoi> {
  const { data = NO_ROI, isPending, isError, refetch } = useQuery(roiQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useActivity(clusterId: string | null): Read<AuditAction[]> {
  const { data = NO_ACTIVITY, isPending, isError, refetch } = useQuery(activityQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

export function useCooldowns(clusterId: string | null): Read<ClusterCooldowns> {
  const { data = NO_COOLDOWNS, isPending, isError, refetch } = useQuery(cooldownsQuery(clusterId));
  return { data, pending: isPending, failed: isError, retry: () => void refetch() };
}

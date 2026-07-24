import type { JobHelpers } from "graphile-worker";
import { applyCluster } from "./apply";
import { classifyCluster } from "./classify";
import { collectCluster } from "./collect";
import { finalizeCluster } from "./finalize";
import { clusterIdFromPayload } from "./payload";

// graphile-worker task registry. collect chains classify on fresh snapshots;
// apply hides approved drops; finalize drops them once the observe window ends.
export const taskList = {
  collect: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    const clusterId = clusterIdFromPayload(payload);
    await collectCluster(clusterId);
    await helpers.addJob("classify", { clusterId });
  },
  classify: async (payload: unknown): Promise<void> => {
    await classifyCluster(clusterIdFromPayload(payload));
  },
  apply: async (payload: unknown): Promise<void> => {
    await applyCluster(clusterIdFromPayload(payload));
  },
  finalize: async (payload: unknown): Promise<void> => {
    await finalizeCluster(clusterIdFromPayload(payload));
  },
};

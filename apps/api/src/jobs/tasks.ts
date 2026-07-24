import type { JobHelpers } from "graphile-worker";
import { applyCluster } from "./apply";
import { classifyCluster } from "./classify";
import { collectCluster } from "./collect";
import { dispatchToAllClusters } from "./dispatch";
import { finalizeCluster } from "./finalize";
import { clusterIdFromPayload } from "./payload";
import { suggestForCluster } from "./suggest";

// graphile-worker task registry. Per-cluster tasks (collect/classify/suggest/
// apply/finalize) plus cron dispatchers that fan those out to every cluster.
export const taskList = {
  collect: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    const clusterId = clusterIdFromPayload(payload);
    await collectCluster(clusterId);
    await helpers.addJob("classify", { clusterId });
    await helpers.addJob("suggest", { clusterId });
  },
  classify: async (payload: unknown): Promise<void> => {
    await classifyCluster(clusterIdFromPayload(payload));
  },
  suggest: async (payload: unknown): Promise<void> => {
    await suggestForCluster(clusterIdFromPayload(payload));
  },
  apply: async (payload: unknown): Promise<void> => {
    await applyCluster(clusterIdFromPayload(payload));
  },
  finalize: async (payload: unknown): Promise<void> => {
    await finalizeCluster(clusterIdFromPayload(payload));
  },
  scheduleCollect: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("collect", helpers);
  },
  scheduleApply: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("apply", helpers);
  },
  scheduleFinalize: async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    await dispatchToAllClusters("finalize", helpers);
  },
};

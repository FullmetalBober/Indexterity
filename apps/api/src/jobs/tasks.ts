import type { JobHelpers } from "graphile-worker";
import { classifyCluster } from "./classify";
import { collectCluster } from "./collect";
import { clusterIdFromPayload } from "./payload";

// graphile-worker task registry. collect chains classify on fresh snapshots.
export const taskList = {
  collect: async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    const clusterId = clusterIdFromPayload(payload);
    await collectCluster(clusterId);
    await helpers.addJob("classify", { clusterId });
  },
  classify: async (payload: unknown): Promise<void> => {
    await classifyCluster(clusterIdFromPayload(payload));
  },
};

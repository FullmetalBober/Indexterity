import { type ClusterEvent, clusterEvent } from "@repo/contracts";
import { z } from "zod";

// The postgres NOTIFY channel the worker's transitions travel on. Postgres is
// the only transport both processes already share (D10 — no redis, no broker):
// graphile-worker itself crosses the same boundary the same way, and the api
// already talks to the worker through it (`graphile_worker.add_job` in
// clusters.controller.ts). Every api replica LISTENs and fans out to its own
// SSE subscribers, so a browser hears the event whichever replica it landed on
// — including the RUN_WORKER=true single-container mode, where the NOTIFY just
// arrives on the process that sent it.
export const CLUSTER_EVENTS_CHANNEL = "cluster_events";

// What travels on the wire: the contract event plus the cluster it belongs to.
// The clusterId is routing, not payload — the listener uses it to pick the
// subscribers and strips it before the event reaches the stream, whose scope
// already names the cluster.
export const clusterEventNotification = clusterEvent.extend({ clusterId: z.uuid() });
export type ClusterEventNotification = z.infer<typeof clusterEventNotification>;

// Null for anything that is not ours: the channel name is not a secret, and a
// stray writer must corrupt nothing — an event the schema does not vouch for
// is not an event.
export function parseClusterEventNotification(payload: string): ClusterEventNotification | null {
  try {
    return clusterEventNotification.parse(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function toClusterEvent(notification: ClusterEventNotification): ClusterEvent {
  return { kind: notification.kind, task: notification.task };
}

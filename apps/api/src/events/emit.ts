import { clusterTask } from "@repo/contracts";
import { type Database, sql } from "../db";
import { CLUSTER_EVENTS_CHANNEL, type ClusterEventNotification } from "./channel";

// Best-effort by contract: an emission is a nudge to refetch, never part of the
// work itself, so it must not be able to fail a pass that already landed its
// writes — a retried apply would re-run `executor.hide` for a refresh nobody
// asked twice for. Swallowing is safe because the failure mode is postgres
// being unreachable, and the pass that just wrote to postgres would already be
// failing loudly on its own.
//
// pg_notify rather than NOTIFY: the payload is a parameter, not something
// spliced into SQL. Delivery is at commit, and these run in autocommit right
// after the state they announce, so a listener acting on one always finds the
// row already changed.
/**
 * Somewhere to announce an event.
 *
 * One method, and it is what this module actually depends on — not a database.
 * Stated as a type because that makes the difference testable without pretending:
 * an object with a `notify` on it IS an EventNotifier, completely, so a test
 * writes one rather than faking a `Database` it implements four members of.
 */
export interface EventNotifier {
  notify(payload: string): Promise<void>;
}

/** The real one: postgres, over the shared channel. */
export function pgNotifier(db: Database): EventNotifier {
  return {
    notify: async (payload) => {
      await db.execute(sql`select pg_notify(${CLUSTER_EVENTS_CHANNEL}, ${payload})`);
    },
  };
}

export async function emitClusterEvent(
  notifier: EventNotifier,
  event: ClusterEventNotification,
): Promise<void> {
  try {
    await notifier.notify(JSON.stringify(event));
  } catch {
    // Deliberately silent — see above. The dashboard's staleTime still
    // refetches on its own schedule, so a lost nudge delays freshness rather
    // than losing anything.
  }
}

// The "a pass finished" event, from runClusterTask's success path. The task
// arrives as a string because that is what the task registry carries; anything
// the contract's enum does not know (a future task name added to the worker
// before the contract) is skipped rather than sent as an event no client can
// interpret.
export async function emitPassFinished(
  notifier: EventNotifier,
  clusterId: string,
  task: string,
): Promise<void> {
  const known = clusterTask.safeParse(task);
  if (!known.success) return;
  await emitClusterEvent(notifier, { clusterId, kind: "PASS_FINISHED", task: known.data });
}

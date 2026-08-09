import { EventEmitter, on } from "node:events";
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { ClusterEvent } from "@repo/contracts";
import { Client } from "pg";
import { coreEnv } from "../config/env";
import { CLUSTER_EVENTS_CHANNEL, parseClusterEventNotification, toClusterEvent } from "./channel";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// One LISTEN per api process, fanned out in memory to that process's SSE
// subscribers. The connection is a dedicated pg Client, not one of the pools:
// LISTEN binds to a session, and a pooled session goes back in the pool.
//
// Losing the connection loses the events sent while it is down — accepted, and
// the reason reconnection does not try to replay anything: an event is a nudge
// to refetch, the queries' staleTime already covers gaps, and the browser
// re-subscribes through the same reconnect loop it uses for its own drops.
@Injectable()
export class ClusterEventsService implements OnApplicationBootstrap, OnModuleDestroy {
  // Keyed by clusterId. Unlimited listeners: every dashboard tab on a cluster
  // is one listener on that cluster's key, and ten tabs is not a leak worth a
  // MaxListenersExceededWarning in the log (a warning is a defect, D20).
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  // Aborts every open subscription. OnModuleDestroy rather than
  // onApplicationShutdown because of Nest's shutdown order: module-destroy
  // hooks run BEFORE the HTTP server closes, and Fastify's close waits for
  // active requests — an SSE stream is one forever, so streams still open at
  // that point hold SIGTERM until the runtime SIGKILLs (main.ts gives it 10s).
  private readonly closing = new AbortController();
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryMs = RECONNECT_MIN_MS;

  async onApplicationBootstrap(): Promise<void> {
    // A failed first connect schedules a retry instead of failing boot: the
    // api can serve everything else while postgres flaps, and the listener
    // catches up when it answers again.
    await this.connect();
  }

  onModuleDestroy(): void {
    this.closing.abort();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = null;
    if (client !== null) void client.end().catch(() => undefined);
  }

  // Everything this cluster's stream should carry, until `signal` (the request
  // closing, or the controller's re-auth deadline) or shutdown ends it.
  async *subscribe(clusterId: string, signal?: AbortSignal): AsyncGenerator<ClusterEvent> {
    const stop =
      signal === undefined ? this.closing.signal : AbortSignal.any([signal, this.closing.signal]);
    try {
      for await (const [event] of on(this.emitter, clusterId, { signal: stop })) {
        yield event as ClusterEvent;
      }
    } catch (error) {
      // The signal firing is the normal way a subscription ends, not a failure
      // to report mid-stream.
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  }

  private async connect(): Promise<void> {
    if (this.closing.signal.aborted) return;
    const client = new Client({ connectionString: coreEnv().DATABASE_URL });
    // A dropped connection surfaces here after connect succeeds. Without a
    // handler it would be an uncaught exception; with one, it is a reconnect.
    client.on("error", () => this.scheduleReconnect());
    try {
      await client.connect();
      client.on("notification", (message) => this.dispatch(message.payload ?? ""));
      await client.query(`listen ${CLUSTER_EVENTS_CHANNEL}`);
      this.client = client;
      this.retryMs = RECONNECT_MIN_MS;
    } catch {
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing.signal.aborted || this.reconnectTimer !== null) return;
    const client = this.client;
    this.client = null;
    if (client !== null) void client.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }

  private dispatch(payload: string): void {
    const notification = parseClusterEventNotification(payload);
    // Not ours — the channel name is not a secret, and garbage must fan out to
    // nobody rather than crash the listener.
    if (notification === null) return;
    this.emitter.emit(notification.clusterId, toClusterEvent(notification));
  }
}

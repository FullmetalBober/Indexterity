import { EventEmitter, on } from "node:events";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { ClusterEvent } from "@repo/contracts";
import { Client } from "pg";
import { coreEnv } from "../config/env";
import { CLUSTER_EVENTS_CHANNEL, parseClusterEventNotification, toClusterEvent } from "./channel";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// How long the listener stays connected after its last subscriber leaves.
//
// Not zero, because a dashboard that is open drops and re-subscribes on a
// schedule: the SSE route caps a stream at five minutes so ownership is
// re-checked (events.controller.ts), and the browser reconnects within
// milliseconds. Disconnecting on the last unsubscribe would tear the LISTEN
// down and rebuild it every five minutes per dashboard — more connection churn
// than the eager listener ever caused, to save nothing.
//
// Thirty seconds is far longer than any reconnect and far shorter than any
// serverless-postgres idle window, so an api nobody is watching is holding
// nothing within a minute.
const IDLE_DISCONNECT_MS = 30_000;

// One LISTEN per api process, fanned out in memory to that process's SSE
// subscribers. The connection is a dedicated pg Client, not one of the pools:
// LISTEN binds to a session, and a pooled session goes back in the pool.
//
// LAZY, and that is the point (#223). It used to connect in
// onApplicationBootstrap, which meant an api with nobody looking at it still
// held one postgres session open forever — measured as the ONLY thing an idle
// api held after #212 made the worker cron-driven, and the one thing that pins a
// database which suspends when idle. Now the session exists exactly while
// somebody is subscribed.
//
// Losing the connection loses the events sent while it is down — accepted, and
// the reason reconnection does not try to replay anything: an event is a nudge
// to refetch, the queries' staleTime already covers gaps, and the browser
// re-subscribes through the same reconnect loop it uses for its own drops. That
// property is what makes disconnecting on idle safe rather than merely cheap: a
// listener that is DOWN loses exactly what a listener that is not yet UP loses,
// and the pipeline already had to be correct under both.
@Injectable()
export class ClusterEventsService implements OnModuleDestroy {
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
  private idleTimer: NodeJS.Timeout | null = null;
  private retryMs = RECONNECT_MIN_MS;
  // In-flight connect, so two subscribers arriving together open one session
  // rather than two.
  private connecting: Promise<void> | null = null;
  private subscribers = 0;

  onModuleDestroy(): void {
    this.closing.abort();
    this.clearTimers();
    this.dropClient();
  }

  // Whether a postgres session is currently held. Exported for the tests and
  // for anything that wants to assert the idle claim rather than trust it.
  get connected(): boolean {
    return this.client !== null;
  }

  // Everything this cluster's stream should carry, until `signal` (the request
  // closing, or the controller's re-auth deadline) or shutdown ends it.
  async *subscribe(clusterId: string, signal?: AbortSignal): AsyncGenerator<ClusterEvent> {
    const stop =
      signal === undefined ? this.closing.signal : AbortSignal.any([signal, this.closing.signal]);
    this.acquire();
    try {
      for await (const [event] of on(this.emitter, clusterId, { signal: stop })) {
        yield event as ClusterEvent;
      }
    } catch (error) {
      // The signal firing is the normal way a subscription ends, not a failure
      // to report mid-stream.
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    } finally {
      // Runs whether the stream ended by signal, by the consumer returning, or
      // by a throw. A refcount that leaked upwards would keep the session open,
      // which is the old behaviour rather than a new failure — the safe
      // direction for a mistake here.
      this.release();
    }
  }

  private acquire(): void {
    this.subscribers += 1;
    // A subscriber arriving inside the grace window cancels the teardown; the
    // session it needs is still up.
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Fire-and-forget. The stream is live either way and a listener that is not
    // up yet drops events exactly as a dropped one does, so a slow or failing
    // connect must not delay — or fail — the subscription itself.
    void this.ensureConnected();
  }

  private release(): void {
    this.subscribers = Math.max(0, this.subscribers - 1);
    if (this.subscribers > 0 || this.idleTimer !== null) return;
    if (this.closing.signal.aborted) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Re-checked rather than assumed: a subscriber may have arrived and left
      // again while this was pending.
      if (this.subscribers === 0) this.goIdle();
    }, IDLE_DISCONNECT_MS);
    // Never hold the process open just to wait for an idle teardown.
    this.idleTimer.unref();
  }

  private goIdle(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retryMs = RECONNECT_MIN_MS;
    this.dropClient();
  }

  private ensureConnected(): Promise<void> {
    if (this.client !== null || this.closing.signal.aborted) return Promise.resolve();
    // Nobody is listening. Reached by a reconnect timer that was armed while a
    // subscriber was still there and fires after it left — connect() would hand
    // the session straight back, but opening one at all is a wake-up the
    // database did not need, which is the whole cost this class exists to avoid.
    if (this.subscribers === 0) return Promise.resolve();
    // A reconnect already pending is the connect attempt; starting a second one
    // would race it.
    if (this.reconnectTimer !== null) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
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
      // The last subscriber may have left while this was connecting — hand the
      // session straight back rather than holding one nobody asked for.
      if (this.subscribers === 0 || this.closing.signal.aborted) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.retryMs = RECONNECT_MIN_MS;
    } catch {
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing.signal.aborted || this.reconnectTimer !== null) return;
    this.dropClient();
    // Nobody is listening, so there is nothing to reconnect FOR. The next
    // subscriber's acquire() opens a fresh session.
    if (this.subscribers === 0) {
      this.retryMs = RECONNECT_MIN_MS;
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, this.retryMs);
    this.reconnectTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.reconnectTimer = null;
    this.idleTimer = null;
  }

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    if (client !== null) void client.end().catch(() => undefined);
  }

  private dispatch(payload: string): void {
    const notification = parseClusterEventNotification(payload);
    // Not ours — the channel name is not a secret, and garbage must fan out to
    // nobody rather than crash the listener.
    if (notification === null) return;
    this.emitter.emit(notification.clusterId, toClusterEvent(notification));
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterEventsService } from "./cluster-events.service";

// The pg Client the service opens for its LISTEN session. Counting instances is
// the whole point of these cases: the claim #223 makes is about how many
// postgres sessions exist, so the double has to be countable.
//
// vi.hoisted because vi.mock's factory is lifted above the imports — the class
// has to exist before the module under test resolves `pg`.
const pg = vi.hoisted(() => {
  const clients: {
    connected: boolean;
    ended: boolean;
    queries: string[];
    handlers: Map<string, (arg: unknown) => void>;
  }[] = [];
  let failNext = false;
  class FakeClient {
    connected = false;
    ended = false;
    queries: string[] = [];
    handlers = new Map<string, (arg: unknown) => void>();
    private readonly fails: boolean;
    constructor() {
      this.fails = failNext;
      failNext = false;
      clients.push(this);
    }
    on(event: string, handler: (arg: unknown) => void): this {
      this.handlers.set(event, handler);
      return this;
    }
    connect(): Promise<void> {
      if (this.fails) return Promise.reject(new Error("connection refused"));
      this.connected = true;
      return Promise.resolve();
    }
    query(sql: string): Promise<void> {
      this.queries.push(sql);
      return Promise.resolve();
    }
    end(): Promise<void> {
      this.ended = true;
      this.connected = false;
      return Promise.resolve();
    }
  }
  return {
    clients,
    FakeClient,
    // Make the NEXT connect fail, so the retry paths can be driven.
    failNextConnect: () => {
      failNext = true;
    },
    reset: () => {
      clients.length = 0;
      failNext = false;
    },
  };
});

// The real pg module with only its Client replaced. Spread rather than
// returned bare: `vi.mock` swaps the WHOLE module, so a factory naming one
// export leaves Pool, types and everything else undefined — and the module type
// is what says so.
vi.mock("pg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pg")>()),
  Client: pg.FakeClient,
}));

const clients = pg.clients;

const live = () => clients.filter((client) => client.connected && !client.ended);

// Drain one subscription for `ms` of fake time, then abort it — which is how a
// stream ends in production (the request closing, or the route's five-minute
// re-auth deadline).
function open(service: InstanceType<typeof ClusterEventsService>, clusterId = "c1") {
  const controller = new AbortController();
  const stream = service.subscribe(clusterId, controller.signal);
  // Start the generator so its body — and its acquire() — actually runs.
  const pump = (async () => {
    for await (const _event of stream) {
      // Events are not what these cases are about.
    }
  })();
  return {
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

let service: InstanceType<typeof ClusterEventsService>;

beforeEach(() => {
  pg.reset();
  vi.useFakeTimers();
  service = new ClusterEventsService();
});

afterEach(() => {
  service.onModuleDestroy();
  vi.useRealTimers();
});

describe("the listener is lazy", () => {
  // The regression #223 is about. Constructing the service used to be enough to
  // open a session, because the connect was in onApplicationBootstrap.
  it("holds no session until somebody subscribes", async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(0);
    expect(service.connected).toBe(false);
  });

  it("opens one session on the first subscriber and listens on the channel", async () => {
    const stream = open(service);
    await vi.advanceTimersByTimeAsync(0);
    expect(live()).toHaveLength(1);
    expect(service.connected).toBe(true);
    expect(clients[0]?.queries).toEqual(["listen cluster_events"]);
    await stream.close();
  });

  // Two tabs are two subscribers and must not be two sessions.
  it("opens one session for many concurrent subscribers", async () => {
    const a = open(service, "c1");
    const b = open(service, "c2");
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);
    await a.close();
    await b.close();
  });
});

describe("the listener goes idle", () => {
  it("drops the session once the last subscriber has been gone for the grace period", async () => {
    const stream = open(service);
    await vi.advanceTimersByTimeAsync(0);
    await stream.close();

    // Still up: the grace window is what stops a reconnecting dashboard
    // churning the session.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(service.connected).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.connected).toBe(false);
    expect(clients[0]?.ended).toBe(true);
  });

  // The route caps a stream at five minutes so ownership is re-checked, so an
  // open dashboard re-subscribes on a schedule. That must reuse the session.
  it("keeps the session when a subscriber returns inside the grace window", async () => {
    const first = open(service);
    await vi.advanceTimersByTimeAsync(0);
    await first.close();

    await vi.advanceTimersByTimeAsync(5_000);
    const second = open(service);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(clients).toHaveLength(1);
    expect(service.connected).toBe(true);
    await second.close();
  });

  it("opens a fresh session for a subscriber who arrives after it went idle", async () => {
    const first = open(service);
    await vi.advanceTimersByTimeAsync(0);
    await first.close();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(service.connected).toBe(false);

    const second = open(service);
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(2);
    expect(service.connected).toBe(true);
    await second.close();
  });
});

describe("failures and shutdown", () => {
  // A failed connect must not fail the subscription: the stream is live either
  // way, and a listener that is not up yet drops events exactly as a dropped
  // one does.
  it("retries a failed connect while somebody is still listening", async () => {
    pg.failNextConnect();
    const stream = open(service);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(service.connected).toBe(true);
    await stream.close();
  });

  // The half that would otherwise leak: retrying forever for an audience that
  // has gone home is the eager listener by another name.
  it("stops retrying once the last subscriber has left", async () => {
    pg.failNextConnect();
    const stream = open(service);
    await vi.advanceTimersByTimeAsync(0);
    await stream.close();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.connected).toBe(false);
    expect(clients).toHaveLength(1);
  });

  // A drop mid-stream is still a reconnect — the audience has not gone away.
  it("reconnects when the connection drops under an open subscriber", async () => {
    const stream = open(service);
    await vi.advanceTimersByTimeAsync(0);
    const first = clients[0];
    first?.handlers.get("error")?.(new Error("server closed the connection"));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(clients).toHaveLength(2);
    expect(service.connected).toBe(true);
    expect(first?.ended).toBe(true);
    await stream.close();
  });

  it("ends the session on shutdown without waiting for the grace period", async () => {
    const stream = open(service);
    await vi.advanceTimersByTimeAsync(0);
    service.onModuleDestroy();
    expect(service.connected).toBe(false);
    expect(clients[0]?.ended).toBe(true);
    await stream.close();
  });
});

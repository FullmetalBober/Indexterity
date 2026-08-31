import { describe, expect, it } from "vitest";
import { messageOf } from "../errors/message";
import {
  looksPooled,
  NotifyProbeError,
  type ProbeClient,
  type ProbeNotification,
  probeNotify,
} from "./notify-probe";

// The pooled endpoint the probe exists for cannot be stood up in a unit test — the
// failure it detects is a pooler silently dropping a notification — so the fake below
// is the pooler: a fanout that can simply be switched off. Everything these cases
// assert is about what the probe DOES with each answer, which is the half that has to
// be right in a boot log at three in the morning.
//
// A factory rather than vi.mock("pg"): the probe takes one, so nothing here has to
// reach around the module system to fake a client.

const DIRECT = "postgres://u:p@db.example.com:5432/indexterity";
const POOLED = "postgres://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db";

interface FakeOptions {
  // Whether a pg_notify reaches the sessions listening on its channel. False is a
  // transaction pooler: the LISTEN is accepted, the NOTIFY returns, and the two land
  // on different backends.
  readonly delivers?: boolean;
  readonly failConnect?: string;
  readonly failListen?: string;
}

function fakeClients(options: FakeOptions = {}) {
  const delivers = options.delivers ?? true;
  // Stands in for the server: which sessions asked for which channel, which is exactly
  // the routing a transaction pooler breaks.
  const listeners = new Map<string, ((message: ProbeNotification) => void)[]>();

  class FakeClient implements ProbeClient {
    connected = false;
    ended = false;
    private notify: (message: ProbeNotification) => void = () => undefined;
    private readonly channels: string[] = [];

    connect(): Promise<unknown> {
      if (options.failConnect !== undefined) return Promise.reject(new Error(options.failConnect));
      this.connected = true;
      return Promise.resolve(this);
    }

    query(sql: string, values?: unknown[]): Promise<unknown> {
      if (sql.startsWith("listen")) {
        if (options.failListen !== undefined) return Promise.reject(new Error(options.failListen));
        // Registered at LISTEN and not at `on("notification")`, so the fake is honest
        // about the order the probe does it in: a notification reaches a session only
        // if that session asked for the channel.
        const channel = sql.slice(sql.indexOf('"') + 1, sql.lastIndexOf('"'));
        this.channels.push(channel);
        listeners.set(channel, [...(listeners.get(channel) ?? []), this.notify]);
        return Promise.resolve(undefined);
      }
      // Checked: pg hands these through as unknown, and a wrong arity here
      // would otherwise deliver `undefined` to every listener.
      const [channel, payload] = values ?? [];
      if (typeof channel !== "string" || typeof payload !== "string") {
        throw new Error(`expected a channel and payload, got ${JSON.stringify(values)}`);
      }
      if (delivers) {
        for (const handler of listeners.get(channel) ?? []) handler({ channel, payload });
      }
      return Promise.resolve(undefined);
    }

    // Taken as a discriminated tuple rather than `(event: string, handler:
    // unknown)`: destructuring one narrows the handler along with the event, so
    // the notification branch has a notification handler without asserting it.
    on(
      ...args:
        | ["notification", (message: ProbeNotification) => void]
        | ["error", (error: Error) => void]
    ): unknown {
      const [event, handler] = args;
      if (event === "notification") this.notify = handler;
      return this;
    }

    end(): Promise<void> {
      this.ended = true;
      this.connected = false;
      for (const channel of this.channels) {
        const remaining = (listeners.get(channel) ?? []).filter((one) => one !== this.notify);
        listeners.set(channel, remaining);
      }
      return Promise.resolve();
    }
  }

  const created: FakeClient[] = [];
  const create = (_connectionString: string): ProbeClient => {
    const client = new FakeClient();
    created.push(client);
    return client;
  };
  return { created, create };
}

// Short everywhere: these cases are about the decision, not about the two seconds a
// real probe is willing to wait.
const FAST = { deliveryTimeoutMs: 20, backoffMs: 0 } as const;

async function refusal(promise: Promise<void>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NotifyProbeError);
    return messageOf(error);
  }
  throw new Error("expected the probe to refuse, and it passed");
}

describe("probeNotify", () => {
  it("passes when the notification arrives", async () => {
    const { create } = fakeClients();
    await expect(
      probeNotify({ connectionString: DIRECT, createClient: create, ...FAST }),
    ).resolves.toBeUndefined();
  });

  it("holds no connection afterwards, on the path that succeeds", async () => {
    // #223 made the SSE listener lazy so an idle api holds zero postgres sessions. A
    // probe that kept either of its two clients would hand that back for the life of
    // the process, and it would do it silently — nothing else in the api would notice
    // one extra session.
    const { created, create } = fakeClients();
    await probeNotify({ connectionString: DIRECT, createClient: create, ...FAST });
    expect(created).toHaveLength(2);
    expect(created.every((client) => client.ended)).toBe(true);
    expect(created.some((client) => client.connected)).toBe(false);
  });

  it("refuses when the notification never arrives, and says which failure it was", async () => {
    const { create } = fakeClients({ delivers: false });
    const message = await refusal(
      probeNotify({ connectionString: DIRECT, createClient: create, ...FAST }),
    );
    expect(message).toContain("does not deliver LISTEN/NOTIFY");
    expect(message).toContain("A LISTEN on a throwaway channel was accepted");
    expect(message).toContain("the notification never arrived");
    // The why, not just the instruction — the reason this is a refusal and not a
    // warning is that nothing else would ever say it.
    expect(message).toContain("LISTEN/NOTIFY does not survive transaction pooling");
    expect(message).toContain("silently never fire");
    expect(message).toContain("direct, non-pooled endpoint");
  });

  it("names the likely fix when the host looks pooled", async () => {
    const { create } = fakeClients({ delivers: false });
    const message = await refusal(
      probeNotify({ connectionString: POOLED, createClient: create, ...FAST }),
    );
    expect(message).toContain("names a pooled endpoint");
    // The hint, never the test: the message must not print the URL it was given.
    expect(message).not.toContain("ep-cool-name-123456-pooler");
  });

  it("leaves the pooled hint out when the host does not look pooled", async () => {
    // A PgBouncer of your own is `db:6432` and matches nothing, so the refusal has to
    // stand on the round trip alone — the same message minus a sentence about Neon.
    const { create } = fakeClients({ delivers: false });
    const message = await refusal(
      probeNotify({ connectionString: DIRECT, createClient: create, ...FAST }),
    );
    expect(message).not.toContain("names a pooled endpoint");
    expect(message).toContain("does not deliver LISTEN/NOTIFY");
  });

  it("says something else entirely when it could not connect at all", async () => {
    const { create } = fakeClients({ failConnect: "ECONNREFUSED 10.0.0.4:5432" });
    const message = await refusal(
      probeNotify({ connectionString: POOLED, createClient: create, ...FAST }),
    );
    expect(message).toContain("never");
    expect(message).toContain("got a working connection");
    expect(message).toContain("ECONNREFUSED 10.0.0.4:5432");
    // The two failures call for opposite actions, so an unreachable database must not
    // arrive dressed as a pooled URL — not even when the host is a pooled one.
    expect(message).toContain("This is NOT the pooled-URL failure");
    expect(message).not.toContain("does not deliver LISTEN/NOTIFY.");
    expect(message).not.toContain("names a pooled endpoint");
  });

  it("reports a LISTEN that was refused as a connection problem, not as pooling", async () => {
    // Accepted-then-swallowed is the pooled signature. A LISTEN that THROWS is
    // something else — a permission, a proxy rejecting the statement — and pointing
    // that operator at a different connection string would waste their evening.
    const { create } = fakeClients({ failListen: "permission denied" });
    const message = await refusal(
      probeNotify({ connectionString: DIRECT, createClient: create, ...FAST }),
    );
    expect(message).toContain("permission denied");
    expect(message).toContain("This is NOT the pooled-URL failure");
  });

  it("retries a bounded number of times before refusing", async () => {
    // Bounded is the requirement in both directions: more than one attempt so a
    // database that was restarting does not crashloop the deployment, and a hard
    // ceiling so the most common failure is not a deploy that hangs.
    const { created, create } = fakeClients({ delivers: false });
    const slept: number[] = [];
    await refusal(
      probeNotify({
        connectionString: DIRECT,
        createClient: create,
        deliveryTimeoutMs: 5,
        backoffMs: 10,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      }),
    );
    // Two clients per attempt, three attempts, and every one of them closed.
    expect(created).toHaveLength(6);
    expect(created.every((client) => client.ended)).toBe(true);
    // Backoff between attempts only — never after the last, which would be a delay
    // in front of an error that is already decided.
    expect(slept).toEqual([10, 20]);
  });

  it("stops at the first attempt that works", async () => {
    const { created, create } = fakeClients();
    await probeNotify({ connectionString: DIRECT, createClient: create, ...FAST });
    expect(created).toHaveLength(2);
  });

  it("takes the attempt count it is given", async () => {
    const { created, create } = fakeClients({ delivers: false });
    await refusal(
      probeNotify({ connectionString: DIRECT, createClient: create, attempts: 1, ...FAST }),
    );
    expect(created).toHaveLength(2);
  });
});

describe("looksPooled", () => {
  it("recognises the two spellings vendors use", () => {
    expect(looksPooled(POOLED)).toBe(true);
    expect(looksPooled("postgres://u:p@aws-0-eu-west-2.pooler.supabase.com:6543/postgres")).toBe(
      true,
    );
  });

  it("does not match a direct host, or a pooler nobody named", () => {
    expect(looksPooled(DIRECT)).toBe(false);
    // A PgBouncer on your own network. The round trip is what catches this one, which
    // is the reason the hostname is only ever a hint.
    expect(looksPooled("postgres://u:p@db:6432/indexterity")).toBe(false);
  });

  it("treats an unparseable URL as no hint rather than as a failure", () => {
    // The schema already refused anything that is not postgres://, so this is only
    // about the probe never being the thing that throws on a value it merely
    // inspected.
    expect(looksPooled("not a url")).toBe(false);
  });
});

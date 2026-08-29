import { describe, expect, it } from "vitest";
import { InsecureConnectionError } from "../engine/tls";
import { UnsupportedServerError } from "../engine/version";
import { TunnelUnavailableError } from "../tunnel/resolve";
import { ClusterCredentialsError, ClusterGoneError } from "./cluster-connection";
import { type ClusterTaskDeps, runClusterTask } from "./tasks";

const CLUSTER = "11111111-1111-1111-1111-111111111111";

function recorder(): {
  deps: ClusterTaskDeps;
  warns: string[];
  errors: string[];
  alerts: string[];
  emitted: string[];
  blocked: string[];
  unblocked: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  const alerts: string[] = [];
  const emitted: string[] = [];
  const blocked: string[] = [];
  const unblocked: string[] = [];
  const claimed = new Set<string>();
  return {
    warns,
    errors,
    alerts,
    emitted,
    blocked,
    unblocked,
    deps: {
      logger: {
        warn: (message) => void warns.push(message),
        error: (message) => void errors.push(message),
      },
      alertOwners: (clusterId, subject) => {
        alerts.push(`${clusterId}:${subject}`);
        return Promise.resolve();
      },
      // The cooldown is a postgres claim now (#212), so the recorder stands in
      // for it with the same rule inside one test: first claim per scope wins.
      // What the WINDOW is belongs to mail/notify.test.ts; what a task does
      // with a suppressed alert belongs here.
      alertAllowed: (scope) => Promise.resolve(claimed.has(scope) ? false : !!claimed.add(scope)),
      emitPassFinished: (clusterId, task) => {
        emitted.push(`${clusterId}:${task}`);
        return Promise.resolve();
      },
      markBlocked: (clusterId, task, reason, detail) => {
        // The pass is in the record because it is now part of what a block says
        // (#408): every assertion below reads this string, so a pass that stopped
        // being threaded through would fail them rather than pass quietly.
        blocked.push(`${clusterId}:${task}:${reason}:${detail}`);
        return Promise.resolve();
      },
      markUnblocked: (clusterId) => {
        unblocked.push(clusterId);
        return Promise.resolve();
      },
    },
  };
}

function unreachable(): Error {
  return new Error("connect ECONNREFUSED 10.0.0.4:27017");
}

const TUNNEL = "22222222-2222-2222-2222-222222222222";

describe("runClusterTask", () => {
  // Offboarding does not reach into the queue, so a deleted cluster's ticks
  // still run. Treating that as a failure costs three retries and a stack trace
  // per orphaned job, and alerts owners about a cluster they deleted.
  it("says nothing when the cluster was deleted before the tick ran", async () => {
    const log = recorder();
    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new ClusterGoneError(CLUSTER);
    });
    expect(log.warns).toHaveLength(0);
    expect(log.errors).toHaveLength(0);
    expect(log.alerts).toHaveLength(0);
    // Nothing recorded either: the row this would be written to is gone, and the
    // owners deleted it on purpose.
    expect(log.blocked).toHaveLength(0);
    expect(log.unblocked).toHaveLength(0);
  });

  it("passes a successful run straight through", async () => {
    const log = recorder();
    let ran = "";
    await runClusterTask("collect", CLUSTER, log.deps, async (id) => {
      ran = id;
    });
    expect(ran).toBe(CLUSTER);
    expect(log.warns).toHaveLength(0);
    expect(log.alerts).toHaveLength(0);
    // The landed pass is announced, so the dashboard can refetch what it wrote.
    expect(log.emitted).toEqual([`${CLUSTER}:collect`]);
    // And whatever stopped the last pass is cleared: the stored state is "why
    // the pipeline is not running", so it cannot survive a pass that ran.
    expect(log.unblocked).toEqual([CLUSTER]);
    expect(log.blocked).toHaveLength(0);
  });

  it("announces nothing for a tick that changed nothing", async () => {
    const log = recorder();
    await runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable()));
    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new ClusterGoneError(CLUSTER);
    });
    expect(log.emitted).toHaveLength(0);
  });

  it("swallows an unreachable cluster and alerts the owners once", async () => {
    const log = recorder();
    // Three ticks of a cluster that has been down all day.
    for (let i = 0; i < 3; i++) {
      await expect(
        runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable())),
      ).resolves.toBeUndefined();
    }
    expect(log.warns).toHaveLength(3);
    expect(log.warns[0]).toContain("unreachable");
    // The cooldown means one email, not one per tick.
    expect(log.alerts).toEqual([`${CLUSTER}:collect skipped — cluster unreachable`]);
  });

  it("keeps the alert cooldown per cluster and per task", async () => {
    const log = recorder();
    const other = "22222222-2222-2222-2222-222222222222";
    await runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable()));
    await runClusterTask("finalize", CLUSTER, log.deps, () => Promise.reject(unreachable()));
    await runClusterTask("collect", other, log.deps, () => Promise.reject(unreachable()));
    expect(log.alerts).toHaveLength(3);
  });

  it("logs undecryptable credentials without emailing the customer", async () => {
    const log = recorder();
    await expect(
      runClusterTask("apply", CLUSTER, log.deps, () =>
        Promise.reject(new ClusterCredentialsError(CLUSTER, 2, new Error("invalid tag"))),
      ),
    ).resolves.toBeUndefined();
    expect(log.errors[0]).toContain("MASTER_KEY_V2");
    expect(log.alerts).toHaveLength(0);
  });

  it("still throws on a real bug, so the job retries and surfaces", async () => {
    const log = recorder();
    await expect(
      runClusterTask("finalize", CLUSTER, log.deps, () =>
        Promise.reject(new TypeError("cannot read properties of undefined")),
      ),
    ).rejects.toThrow(TypeError);
    expect(log.warns).toHaveLength(0);
  });

  it("reports an unsupported server once a day and does not retry it", async () => {
    const log = recorder();
    const tooOld = new UnsupportedServerError("MongoDB 4.2.24 cannot hide indexes");
    for (let i = 0; i < 3; i++) {
      await expect(
        runClusterTask("apply", CLUSTER, log.deps, () => Promise.reject(tooOld)),
      ).resolves.toBeUndefined();
    }
    expect(log.warns).toHaveLength(3);
    expect(log.alerts).toEqual([`${CLUSTER}:cluster version not supported`]);
  });
});

// A stored string that predates TLS enforcement, or one connected while the
// deployment allowed plaintext. No retry fixes it — only the owner reconnecting
// — so it takes the shape of an unsupported version rather than of a failure.
describe("runClusterTask on a cluster we refuse to dial", () => {
  it("skips the tick, warns every time, and mails the owners once", async () => {
    const log = recorder();
    const insecure = new InsecureConnectionError("refusing to connect without validated TLS");
    for (let i = 0; i < 3; i++) {
      await expect(
        runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(insecure)),
      ).resolves.toBeUndefined();
    }
    expect(log.warns).toHaveLength(3);
    expect(log.alerts).toEqual([
      `${CLUSTER}:collect skipped — this cluster's connection string is not using TLS`,
    ]);
    // Nothing landed, so nothing for the dashboard to refetch.
    expect(log.emitted).toHaveLength(0);
  });

  // The distinction that matters to whoever reads the email: the cluster may be
  // perfectly healthy and we are declining to dial it. "We could not reach you"
  // would send them hunting a firewall that is not the problem.
  it("is not reported as unreachable", async () => {
    const log = recorder();
    await runClusterTask("collect", CLUSTER, log.deps, () =>
      Promise.reject(new InsecureConnectionError("refusing to connect without validated TLS")),
    );
    expect(log.alerts.join()).not.toContain("unreachable");
    expect(log.warns.join()).not.toContain("unreachable");
  });

  // #353. A tunnel that will not come up is its own condition: the database
  // behind it may be answering perfectly, and we never dialled it.
  describe("a cluster behind a tunnel that is down", () => {
    it("skips the tick rather than throwing, so no retry is burned", async () => {
      const log = recorder();
      await expect(
        runClusterTask("collect", CLUSTER, log.deps, () => {
          throw new TunnelUnavailableError(TUNNEL);
        }),
      ).resolves.toBeUndefined();
      expect(log.warns[0]).toContain(TUNNEL);
    });

    it("announces nothing, because the tick changed nothing", async () => {
      const log = recorder();
      await runClusterTask("collect", CLUSTER, log.deps, () => {
        throw new TunnelUnavailableError(TUNNEL);
      });
      expect(log.emitted).toHaveLength(0);
    });

    // The mail has to name the VPN, not the database. Saying "we could not
    // reach your cluster" sends somebody to look at a database that is fine.
    it("tells the owners the tunnel is down, not that the cluster is unreachable", async () => {
      const log = recorder();
      await runClusterTask("collect", CLUSTER, log.deps, () => {
        throw new TunnelUnavailableError(TUNNEL);
      });
      expect(log.alerts).toEqual([
        `${CLUSTER}:collect skipped — the VPN tunnel to this cluster is down`,
      ]);
    });

    // One gateway commonly reaches several clusters. Keying the cooldown on the
    // cluster would mail a customer once per database behind one down VPN.
    it("alerts once per TUNNEL, not once per cluster behind it", async () => {
      const log = recorder();
      const second = "33333333-3333-3333-3333-333333333333";
      await runClusterTask("collect", CLUSTER, log.deps, () => {
        throw new TunnelUnavailableError(TUNNEL);
      });
      await runClusterTask("collect", second, log.deps, () => {
        throw new TunnelUnavailableError(TUNNEL);
      });
      expect(log.alerts).toHaveLength(1);
    });

    it("still alerts separately for a different tunnel", async () => {
      const log = recorder();
      const other = "44444444-4444-4444-4444-444444444444";
      await runClusterTask("collect", CLUSTER, log.deps, () => {
        throw new TunnelUnavailableError(TUNNEL);
      });
      await runClusterTask("collect", CLUSTER, log.deps, () => {
        throw new TunnelUnavailableError(other);
      });
      expect(log.alerts).toHaveLength(2);
    });
  });

  // The gap this closes. The condition was always diagnosed here — a metric, a
  // log line, a mail once a day — and then thrown away, so a dashboard opened a
  // week later could only show `lastCollectedAt` going stale, which has innocent
  // causes and reads as "nothing is obviously wrong".
  it("records why the pipeline stopped, in the driver's own words", async () => {
    const log = recorder();

    await runClusterTask("collect", CLUSTER, log.deps, () => Promise.reject(unreachable()));

    expect(log.blocked).toEqual([
      `${CLUSTER}:collect:UNREACHABLE:connect ECONNREFUSED 10.0.0.4:27017`,
    ]);
    expect(log.unblocked).toHaveLength(0);
  });

  // #408: the block records WHICH pass stopped, and the dashboard words itself
  // from it. In production a failing `suggest` was reported to the owner as
  // collection failing, because this was thrown away and the banner guessed.
  it("records the pass that failed, not always collect", async () => {
    const log = recorder();

    await runClusterTask("suggest", CLUSTER, log.deps, () =>
      Promise.reject(new Error("socket hang up")),
    ).catch(() => {});

    expect(log.blocked).toEqual([`${CLUSTER}:suggest:ERROR:socket hang up`]);
  });

  // #407. In production a `suggest` against a tunnelled MSSQL cluster with 13
  // observed databases ran for HOURS: there was a 15-minute budget per query and
  // none at all for the pass, so it could not finish inside the life of the
  // process, and WORKER_CONCURRENCY is 1 — nothing else in the pipeline drained
  // behind it.
  it("abandons a read-only pass that runs past its budget", async () => {
    const log = recorder();
    // Never settles, which is what a pass that cannot finish looks like.
    const forever = () => new Promise<void>(() => {});

    await runClusterTask("suggest", CLUSTER, log.deps, forever, 20);

    expect(log.blocked).toEqual([
      `${CLUSTER}:suggest:TIMED_OUT:the suggest pass ran past its 20ms budget and was abandoned`,
    ]);
  });

  // Skipped, not rethrown — the difference decides whether graphile-worker
  // retries immediately. It must not: the retry gets the same budget against the
  // same cluster, so five attempts later it is dead-lettered having spent five
  // budgets of the only worker slot achieving nothing. The next tick starts
  // clean instead.
  it("skips a budget overrun rather than rethrowing it for an immediate retry", async () => {
    const log = recorder();

    await expect(
      runClusterTask("collect", CLUSTER, log.deps, () => new Promise<void>(() => {}), 20),
    ).resolves.toBeUndefined();
  });

  // Without a budget nothing changes, which is what `apply` and `finalize` get:
  // a pass cut off between changing an index and recording it is a change we
  // have half a record of, and a large build legitimately takes far longer than
  // any budget a read would want.
  it("lets a pass run unbounded when it has no budget", async () => {
    const log = recorder();
    let settle: (() => void) | undefined;
    const slow = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });

    const running = runClusterTask("apply", CLUSTER, log.deps, slow, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Still going, where a budgeted pass would have been abandoned by now.
    expect(log.blocked).toHaveLength(0);
    settle?.();
    await running;

    expect(log.blocked).toHaveLength(0);
    expect(log.unblocked).toEqual([CLUSTER]);
  });

  // A pass inside its budget must not be touched by the machinery at all.
  it("leaves a pass that finishes in time alone", async () => {
    const log = recorder();

    await runClusterTask("collect", CLUSTER, log.deps, () => Promise.resolve(), 10_000);

    expect(log.blocked).toHaveLength(0);
    expect(log.unblocked).toEqual([CLUSTER]);
  });

  it("blames the tunnel rather than the database when the tunnel is down", async () => {
    const log = recorder();

    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new TunnelUnavailableError(TUNNEL);
    });

    // Its own reason, for the reason the mail and the metric keep theirs: the
    // database may be answering perfectly and we never dialled it.
    expect(log.blocked[0]).toContain(":TUNNEL_DOWN:");
    expect(log.blocked[0]).toContain("gateway");
  });

  it("distinguishes declining to dial from failing to reach", async () => {
    const log = recorder();

    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new InsecureConnectionError("the stored string would connect in plaintext");
    });

    expect(log.blocked[0]).toContain(":INSECURE:");
    expect(log.blocked[0]).not.toContain("UNREACHABLE");
  });

  it("records an unsupported server, which no retry can fix", async () => {
    const log = recorder();

    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new UnsupportedServerError("mongodb 4.4 is below the floor");
    });

    expect(log.blocked[0]).toBe(`${CLUSTER}:collect:UNSUPPORTED:mongodb 4.4 is below the floor`);
  });

  it("records credentials that cannot be opened, which needs an operator", async () => {
    const log = recorder();

    await runClusterTask("collect", CLUSTER, log.deps, () => {
      throw new ClusterCredentialsError(CLUSTER, 2, new Error("no key for version 2"));
    });

    expect(log.blocked[0]).toContain(":CREDENTIALS:");
  });

  it("records an unexpected failure BEFORE rethrowing it", async () => {
    const log = recorder();

    // Rethrown so graphile-worker retries and eventually dead-letters it — but an
    // owner should not have to wait for that to find out collection stopped.
    await expect(
      runClusterTask("collect", CLUSTER, log.deps, () => {
        throw new Error("something nobody has classified");
      }),
    ).rejects.toThrow("something nobody has classified");

    expect(log.blocked).toEqual([`${CLUSTER}:collect:ERROR:something nobody has classified`]);
  });
});

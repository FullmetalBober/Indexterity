import { describe, expect, it, vi } from "vitest";
import { ObservedSession, scopeForDiagnosis, unobservedDatabases } from "./observe";
import type { EngineSession, IndexCollector, IndexExecutor } from "./ports";
import { DatabaseInaccessibleError } from "./ports";

// Required by EngineSession and only ever forwarded: ObservedSession hands both
// straight through, and these tests drive the database scoping. So every member
// REFUSES rather than `{} as IndexCollector`, which claims an empty object is a
// thirteen-member port and answers `undefined` to anything asked — and unlike a
// Proxy asserted into the port, nothing here is claimed.
function neverAsked(what: string): never {
  throw new Error(`${what} is not used by these tests`);
}

// Written out rather than proxied into shape, so the compiler is what keeps the
// double complete: a member added to either port fails here instead of being
// silently uncovered. Each body returns `never`, which satisfies whatever the
// port says the member returns.
const REFUSING_COLLECTOR: IndexCollector = {
  listCollectionNames: () => neverAsked("collector.listCollectionNames"),
  listIndexes: () => neverAsked("collector.listIndexes"),
  collectUsage: () => neverAsked("collector.collectUsage"),
  indexSizes: () => neverAsked("collector.indexSizes"),
  collectionStorage: () => neverAsked("collector.collectionStorage"),
  readLatency: () => neverAsked("collector.readLatency"),
  collectionLatency: () => neverAsked("collector.collectionLatency"),
  collectSlowQueries: () => neverAsked("collector.collectSlowQueries"),
  collectWorkload: () => neverAsked("collector.collectWorkload"),
  collectDeletePatterns: () => neverAsked("collector.collectDeletePatterns"),
  collectServerHealth: () => neverAsked("collector.collectServerHealth"),
  collectNodes: () => neverAsked("collector.collectNodes"),
  collectHintedIndexes: () => neverAsked("collector.collectHintedIndexes"),
};

const REFUSING_EXECUTOR: IndexExecutor = {
  hide: () => neverAsked("executor.hide"),
  unhide: () => neverAsked("executor.unhide"),
  drop: () => neverAsked("executor.drop"),
  create: () => neverAsked("executor.create"),
  settleBuild: () => neverAsked("executor.settleBuild"),
};

function session(names: string[]): EngineSession {
  return {
    collector: REFUSING_COLLECTOR,
    executor: () => REFUSING_EXECUTOR,
    listDatabaseNames: vi.fn(async () => names),
    ping: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("scopeForDiagnosis", () => {
  it("is every database when nothing was selected", () => {
    expect(scopeForDiagnosis(["app", "staging"], null)).toEqual(["app", "staging"]);
    expect(scopeForDiagnosis(["app", "staging"], undefined)).toEqual(["app", "staging"]);
  });

  it("narrows to the selection, in the cluster's order", () => {
    expect(scopeForDiagnosis(["app", "staging", "restore"], ["restore", "app"])).toEqual([
      "app",
      "restore",
    ]);
  });

  // The verdict a scoped role gets: with the whole cluster in scope an anyDb
  // requirement fails on the databases the role does not cover, and with only the
  // covered ones in scope it passes. That is the behaviour this narrowing exists
  // for (#244), and it is why the empty case must not silently become "nothing".
  it("falls back to the whole cluster when every selected database is gone", () => {
    expect(scopeForDiagnosis(["app"], ["staging-that-was-dropped"])).toEqual(["app"]);
  });

  it("has nothing to fall back to on a cluster with no user databases", () => {
    expect(scopeForDiagnosis([], ["app"])).toEqual([]);
  });
});

describe("unobservedDatabases", () => {
  it("is empty when everything is observed", () => {
    expect(unobservedDatabases(["app", "staging"], null)).toEqual([]);
    expect(unobservedDatabases(["app", "staging"], ["app", "staging"])).toEqual([]);
  });

  it("names what the selection leaves out", () => {
    expect(unobservedDatabases(["app", "staging", "restore"], ["app"])).toEqual([
      "staging",
      "restore",
    ]);
  });
});

describe("ObservedSession", () => {
  it("reports only the observed databases", async () => {
    const wrapped = new ObservedSession(session(["app", "staging", "restore"]), ["app", "restore"]);
    expect(await wrapped.listDatabaseNames()).toEqual(["app", "restore"]);
  });

  // The opposite rule from scopeForDiagnosis, and the important half of it: a
  // collect that fell back to every database when the selection matched nothing
  // would walk exactly the databases the owner excluded.
  it("walks nothing when every selected database is gone", async () => {
    const wrapped = new ObservedSession(session(["app"]), ["staging-that-was-dropped"]);
    expect(await wrapped.listDatabaseNames()).toEqual([]);
  });

  it("picks a database back up when it returns", async () => {
    const inner = session(["app"]);
    const wrapped = new ObservedSession(inner, ["app", "staging"]);
    expect(await wrapped.listDatabaseNames()).toEqual(["app"]);
    vi.mocked(inner.listDatabaseNames).mockResolvedValue(["app", "staging"]);
    expect(await wrapped.listDatabaseNames()).toEqual(["app", "staging"]);
  });

  it("delegates everything else, and does not close the pooled session itself", async () => {
    const inner = session(["app"]);
    const wrapped = new ObservedSession(inner, ["app"]);
    await wrapped.ping();
    expect(inner.ping).toHaveBeenCalledOnce();
    wrapped.executor(true);
    expect(wrapped.collector).toBe(inner.collector);
    await wrapped.close();
    expect(inner.close).toHaveBeenCalledOnce();
  });
});

describe("a database the credentials cannot reach", () => {
  // The failure the two database-walking passes must survive, rather than abort
  // on (#244). Proven against SQL Server 2022: a login provisioned for one
  // database of two is still shown the other by `sys.databases` — VIEW ANY
  // DATABASE is granted to public — and then answers Msg 916, "The server
  // principal … is not able to access the database … under the current security
  // context", to every read of it.
  it("is one lost database and not a lost collect", async () => {
    const collector = {
      listCollectionNames: vi.fn(async (database: string) => {
        if (database === "stagingdb") throw new DatabaseInaccessibleError(database);
        return [`${database}.orders`];
      }),
    };
    const walked: string[] = [];
    for (const database of ["appdb", "stagingdb", "reportdb"]) {
      try {
        walked.push(...(await collector.listCollectionNames(database)));
      } catch (error) {
        if (!(error instanceof DatabaseInaccessibleError)) throw error;
      }
    }
    expect(walked).toEqual(["appdb.orders", "reportdb.orders"]);
  });

  it("names the database it could not reach", () => {
    const error = new DatabaseInaccessibleError("stagingdb");
    expect(error.database).toBe("stagingdb");
    expect(error.message).toContain("stagingdb");
  });
});

import { describe, expect, it } from "vitest";
import { scopeForDiagnosis } from "../engine/observe";
import {
  canProvisionWith,
  evaluatePrivileges,
  evaluateProvisioning,
  evaluateSurplus,
  type MongoPrivilege,
  type MongoRole,
  queryStatsAdvisory,
} from "./diagnose";
import { ENGINE_PRIVILEGES } from "./provision";
import { parseServerVersion } from "./version";

// The privilege set our own provisioned role grants — IMPORTED, not restated.
//
// This used to be a verbatim copy of `ENGINE_PRIVILEGES`, which is the shape
// that keeps passing while production drifts: an action added to the real role
// would leave every expectation below green about a role nobody grants. The
// expectations are still written out, because what is under test is which
// diagnose checks a privilege set satisfies — that mapping is the rule, and it
// is not derivable from the list.
// Copied element-wise only because the role declares `readonly` arrays and the
// zod-inferred reader type does not — the CONTENTS come from production.
const enginePrivileges: MongoPrivilege[] = ENGINE_PRIVILEGES.map((privilege) => ({
  resource: privilege.resource,
  actions: [...privilege.actions],
}));

function granted(privileges: readonly MongoPrivilege[], databases: string[] = []): string[] {
  return evaluatePrivileges(privileges, databases)
    .filter((check) => check.granted)
    .map((check) => check.key);
}

function missing(privileges: MongoPrivilege[], databases: string[] = []): string[] {
  return evaluatePrivileges(privileges, databases)
    .filter((check) => !check.granted)
    .map((check) => check.key);
}

describe("evaluatePrivileges", () => {
  it("passes everything for the role Indexterity provisions", () => {
    expect(missing(enginePrivileges)).toEqual([]);
  });

  it("names exactly what a read-only user is missing", () => {
    // `read` on every database: find/listIndexes/listCollections but no stats
    // aggregation stages and no DDL.
    const readOnly: MongoPrivilege[] = [
      { resource: { db: "", collection: "" }, actions: ["find", "listIndexes", "listCollections"] },
    ];
    const gaps = missing(readOnly);
    expect(gaps).toContain("listDatabases");
    expect(gaps).toContain("indexStats");
    expect(gaps).toContain("collStats");
    expect(gaps).toContain("createIndex");
    expect(gaps).not.toContain("listIndexes");
  });

  it("treats anyResource as covering everything", () => {
    const root: MongoPrivilege[] = [
      {
        resource: { anyResource: true },
        actions: [
          "listDatabases",
          "listCollections",
          "listIndexes",
          "indexStats",
          "collStats",
          "createIndex",
          "dropIndex",
          "collMod",
          "serverStatus",
          "find",
          "queryStatsRead",
          "queryStatsReadTransformed",
        ],
      },
    ];
    expect(missing(root)).toEqual([]);
  });

  it("accepts per-database grants only when every user database is covered", () => {
    const perDb: MongoPrivilege[] = [
      { resource: { cluster: true }, actions: ["listDatabases"] },
      {
        resource: { db: "app", collection: "" },
        actions: ["listCollections", "listIndexes", "indexStats", "collStats"],
      },
    ];
    expect(granted(perDb, ["app"])).toContain("indexStats");
    // A second database the grant does not cover breaks it.
    expect(missing(perDb, ["app", "reporting"])).toContain("indexStats");
    // With no databases discovered, only a wildcard grant would count.
    expect(missing(perDb, [])).toContain("indexStats");
  });

  // The whole reason the observe selection reaches diagnose (#244). Same role,
  // same cluster, two verdicts: a role covering one database of three is a gap
  // while the whole cluster is in scope, and a grant once the selection says which
  // database we were asked to look at. Without this the only way to connect such a
  // cluster is to widen the role over databases nobody asked us to read.
  it("turns a per-database role from a gap into a grant when the selection narrows", () => {
    const scopedToApp: MongoPrivilege[] = [
      { resource: { cluster: true }, actions: ["listDatabases"] },
      {
        resource: { db: "app", collection: "" },
        actions: ["listCollections", "listIndexes", "indexStats", "collStats"],
      },
    ];
    const available = ["app", "staging", "restore"];
    expect(missing(scopedToApp, scopeForDiagnosis(available, null))).toContain("indexStats");
    expect(granted(scopedToApp, scopeForDiagnosis(available, ["app"]))).toContain("indexStats");
    // And a selection whose databases have all been dropped reads as the whole
    // cluster rather than as a role with no privileges anywhere.
    expect(missing(scopedToApp, scopeForDiagnosis(available, ["gone"]))).toContain("indexStats");
  });

  it("requires BOTH queryStats actions (verified live on mongo 8)", () => {
    const partial: MongoPrivilege[] = [
      { resource: { cluster: true }, actions: ["listDatabases", "queryStatsRead"] },
    ];
    expect(missing(partial)).toContain("queryStats");
  });

  it("classifies tiers so a read-only user is analysis-ready but cannot apply", () => {
    const analyzeOnly: MongoPrivilege[] = [
      { resource: { cluster: true }, actions: ["listDatabases"] },
      {
        resource: { db: "", collection: "" },
        actions: ["listCollections", "listIndexes", "indexStats", "collStats"],
      },
    ];
    const checks = evaluatePrivileges(analyzeOnly, []);
    expect(checks.filter((c) => c.tier === "CORE").every((c) => c.granted)).toBe(true);
    expect(checks.filter((c) => c.tier === "APPLY").some((c) => c.granted)).toBe(false);
  });
});

describe("canProvisionWith", () => {
  it("is true for user-admin credentials", () => {
    expect(
      canProvisionWith([
        {
          resource: { db: "", collection: "" },
          actions: ["createRole", "createUser", "grantRole"],
        },
      ]),
    ).toBe(true);
  });

  it("is false for the engine role itself", () => {
    expect(canProvisionWith(enginePrivileges)).toBe(false);
  });

  it("is false when only part of the user-management set is granted", () => {
    expect(
      canProvisionWith([{ resource: { db: "admin", collection: "" }, actions: ["createUser"] }]),
    ).toBe(false);
  });

  // root carries userAdminAnyDatabase, whose privileges arrive on the
  // anyDatabase resource rather than on `admin` by name. This is the case the
  // report on #86 suspected was broken; it is not, and the test says so rather
  // than the next reader having to re-derive it from grantsNamespace.
  it("is true for anyResource, as root reports it", () => {
    expect(
      canProvisionWith([
        { resource: { anyResource: true }, actions: ["createRole", "createUser", "grantRole"] },
      ]),
    ).toBe(true);
  });
});

// The half of #86 that was a bug whichever way the detection went: a false
// `canProvision` has to carry the reason, and the reason is per action.
describe("evaluateProvisioning", () => {
  it("names the exact action a partly privileged user is missing", () => {
    const gaps = evaluateProvisioning([
      { resource: { db: "admin", collection: "" }, actions: ["createRole", "createUser"] },
    ]).filter((check) => !check.granted);
    expect(gaps.map((check) => check.key)).toEqual(["grantRole"]);
  });

  // What an Atlas cluster's own admin looks like: broad on data, nothing on user
  // management (Atlas manages users through its UI/API). "Correct answer, badly
  // delivered" was the likelier half of the report — so the answer now arrives
  // with all three actions named.
  it("reports all three for credentials that manage no users at all", () => {
    const atlasAdmin: MongoPrivilege[] = [
      { resource: { cluster: true }, actions: ["listDatabases", "serverStatus"] },
      {
        resource: { db: "", collection: "" },
        actions: ["listCollections", "listIndexes", "indexStats", "collStats"],
      },
    ];
    expect(evaluateProvisioning(atlasAdmin).map((check) => check.granted)).toEqual([
      false,
      false,
      false,
    ]);
    expect(evaluateProvisioning(atlasAdmin).every((check) => check.tier === "PROVISION")).toBe(
      true,
    );
  });

  // The engine's own requirements and the provisioning ones are answered from one
  // privilege set but must not bleed into each other: `missing` drives the
  // dashboard's red alert and createCluster's refusal, and neither is about
  // whether we could have made our own user.
  it("does not make a provisioning gap look like a missing engine privilege", () => {
    expect(missing(enginePrivileges)).toEqual([]);
    expect(canProvisionWith(enginePrivileges)).toBe(false);
  });
});

// $queryStats is off by default on every version, and before 8.0 it cannot
// report whether a query scanned. Both are silent failures without this.
describe("queryStatsAdvisory", () => {
  const v8 = parseServerVersion("8.2.9");
  const v7 = parseServerVersion("7.0.39");

  it("says nothing when the store is sampling on a version that reports plans", () => {
    expect(queryStatsAdvisory(-1, v8)).toBeNull();
    expect(queryStatsAdvisory(100, v8)).toBeNull();
  });

  it("names the parameter when sampling is off", () => {
    const advisory = queryStatsAdvisory(0, v8);
    expect(advisory).toContain("internalQueryStatsRateLimit");
    expect(advisory).toContain("profiler");
  });

  it("explains that a pre-8.0 store counts executions but cannot see scans", () => {
    const advisory = queryStatsAdvisory(-1, v7);
    expect(advisory).toContain("7.0.39");
    expect(advisory).toContain("execution counts only");
    expect(advisory).toContain("profiler");
  });

  it("prefers the sampling problem, which makes the version moot", () => {
    expect(queryStatsAdvisory(0, v7)).toContain("internalQueryStatsRateLimit");
  });

  it("stays quiet when the parameter could not be read", () => {
    expect(queryStatsAdvisory(null, v7)).toBeNull();
  });
});

// #313. The list read backwards: what this user holds and the engine never uses.
describe("evaluateSurplus", () => {
  const scoped: MongoRole[] = [{ role: "indexterityEngine", db: "admin" }];

  it("finds nothing on the role we provision ourselves", () => {
    // The reassuring case, and it has to be EMPTY rather than a list of ticks:
    // the screen says "nothing" in words, and a row per absent grant would bury
    // the finding when there is one (#289).
    expect(
      evaluateSurplus(scoped, enginePrivileges, ["app"], { user: "idx_a91f", db: "admin" }),
    ).toEqual([]);
  });

  it("names root and hands over the revoke", () => {
    const checks = evaluateSurplus(
      [{ role: "root", db: "admin" }],
      [{ resource: { anyResource: true }, actions: ["insert", "update", "remove"] }],
      ["app"],
      { user: "admin", db: "admin" },
    );
    const root = checks.find((check) => check.key === "surplus_root");
    expect(root?.granted).toBe(true);
    expect(root?.tier).toBe("SURPLUS");
    // The command is the REVERSE direction for a surplus row: what removes the
    // grant, not what adds it.
    expect(root?.command).toBe(
      'db.getSiblingDB("admin").revokeRolesFromUser("admin", [{ role: "root", db: "admin" }])',
    );
  });

  it("reports a per-database dbOwner once per database it is held on", () => {
    const checks = evaluateSurplus(
      [
        { role: "dbOwner", db: "app" },
        { role: "dbOwner", db: "reporting" },
      ],
      enginePrivileges,
      ["app"],
      { user: "appuser", db: "admin" },
    );
    const owner = checks.find((check) => check.key === "surplus_dbOwner");
    expect(owner?.label).toBe("dbOwner on app, reporting");
    // Both databases in one statement, because a `dbOwner` on two databases is
    // two memberships and one revoke call takes a list.
    expect(owner?.command).toContain('{ role: "dbOwner", db: "app" }');
    expect(owner?.command).toContain('{ role: "dbOwner", db: "reporting" }');
  });

  it("names write access separately, and does not print the same revoke twice", () => {
    const checks = evaluateSurplus(
      [{ role: "readWriteAnyDatabase", db: "admin" }],
      [{ resource: { db: "", collection: "" }, actions: ["insert", "update", "remove"] }],
      ["app"],
      { user: "appuser", db: "admin" },
    );
    const write = checks.find((check) => check.key === "surplus_write");
    expect(write?.label).toBe("insert, update, remove on the databases in scope");
    // The role above carries it and prints the statement; printing it again here
    // is how a reader runs one revoke and believes two things are outstanding.
    expect(write?.command).toBeNull();
    expect(write?.enables).toContain("which is what the role above carries");
  });

  it("says a custom role is the source when no built-in role explains the writes", () => {
    const checks = evaluateSurplus(
      [{ role: "appWriter", db: "app" }],
      [{ resource: { db: "app", collection: "" }, actions: ["insert"] }],
      ["app"],
      { user: "appuser", db: "admin" },
    );
    // No role row — `appWriter` is not one of the built-ins we can name a
    // replacement for — so the write row has to carry the whole finding, and it
    // has to say where the reader goes instead of a command we cannot write.
    expect(checks.map((check) => check.key)).toEqual(["surplus_write"]);
    expect(checks[0]?.enables).toContain("db.updateRole");
  });

  it("issues the revoke against the user's own database, not admin", () => {
    // Measured on 8.0: `revokeRolesFromUser` resolves the user in the database it
    // is issued against, so `getSiblingDB("admin")` answers UserNotFound for a
    // user created in `app` — "Could not find user \"owner\" for db \"admin\"".
    // Very common, because a customer's own application user usually lives beside
    // its data rather than in admin.
    const checks = evaluateSurplus([{ role: "dbOwner", db: "app" }], enginePrivileges, ["app"], {
      user: "owner",
      db: "app",
    });
    expect(checks.find((check) => check.key === "surplus_dbOwner")?.command).toBe(
      'db.getSiblingDB("app").revokeRolesFromUser("owner", [{ role: "dbOwner", db: "app" }])',
    );
  });

  it("has no revoke to offer when nothing is authenticated", () => {
    // A deployment with auth off holds every role and has no user to revoke them
    // from. The diagnosis reports no surplus at all in that case; this pins the
    // helper's own behaviour so a future caller cannot produce an unrunnable row.
    const checks = evaluateSurplus([{ role: "root", db: "admin" }], [], [], null);
    expect(checks[0]?.command).toBeNull();
  });
});

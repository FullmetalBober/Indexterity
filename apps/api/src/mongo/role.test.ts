import { describe, expect, it } from "vitest";
import { REQUIRED_PRIVILEGES } from "./diagnose";
import { ENGINE_PRIVILEGES, ENGINE_ROLE, grantChangesStatement, ROLE_CHANGES } from "./role";

describe("ENGINE_PRIVILEGES", () => {
  // The derivation is the base plus every change, and what it derives has to be
  // exactly the role the wiki documents and provisioning creates.
  it("is the base role with every change folded in", () => {
    expect(ENGINE_PRIVILEGES).toEqual([
      {
        resource: { cluster: true },
        actions: ["listDatabases", "serverStatus", "queryStatsRead", "queryStatsReadTransformed"],
      },
      {
        resource: { db: "", collection: "" },
        actions: [
          "listCollections",
          "listIndexes",
          "indexStats",
          "collStats",
          "createIndex",
          "dropIndex",
          "collMod",
          "enableProfiler",
        ],
      },
      { resource: { db: "", collection: "system.profile" }, actions: ["find"] },
      { resource: { db: "config", collection: "collections" }, actions: ["find"] },
    ]);
  });
});

describe("ROLE_CHANGES", () => {
  it("counts revisions from one, in order", () => {
    expect(ROLE_CHANGES.map((change) => change.revision)).toEqual(
      ROLE_CHANGES.map((_, index) => index + 1),
    );
  });

  it("names the release that asked for each", () => {
    for (const change of ROLE_CHANGES) expect(change.release).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The rule #599 rests on: a privilege added after clusters already exist is
  // OPTIONAL. A cluster without it loses the one feature it serves, with a reason,
  // and nothing that worked stops working — so a release can never break a
  // cluster by needing something its role was not given.
  it("adds only privileges the engine treats as optional", () => {
    for (const change of ROLE_CHANGES) {
      const check = REQUIRED_PRIVILEGES.find((required) => required.key === change.check);
      expect(check, `no diagnose check called ${change.check}`).toBeDefined();
      expect(check?.tier).toBe("WORKLOAD");
      // And the check asks for exactly what the change grants, so a cluster that
      // ran the grant diagnoses clean and the notice clears.
      expect([...(check?.actions ?? [])].sort()).toEqual([...change.grant.actions].sort());
    }
  });
});

describe("grantChangesStatement", () => {
  it("grants every change after the revision given, to the role by name", () => {
    expect(grantChangesStatement(0)).toBe(
      `db.getSiblingDB("admin").grantPrivilegesToRole("${ENGINE_ROLE}", ` +
        '[{"resource":{"db":"","collection":""},"actions":["enableProfiler"]}])',
    );
  });

  it("is null once nothing is left to grant", () => {
    expect(grantChangesStatement(ROLE_CHANGES.length)).toBeNull();
  });
});

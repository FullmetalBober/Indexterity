import { describe, expect, it } from "vitest";
import { ENGINE_PRIVILEGES, scopedConnString } from "./provision";

describe("scopedConnString", () => {
  it("swaps credentials and forces authSource=admin, preserving topology", () => {
    const out = scopedConnString(
      "mongodb://root:hunter2@h1:27017,h2:27018/app?replicaSet=rs0&tls=true&authSource=other",
      "idx_ab12cd34ef56",
      "p-w_9",
    );
    expect(out).toBe(
      "mongodb://idx_ab12cd34ef56:p-w_9@h1:27017,h2:27018/app?replicaSet=rs0&tls=true&authSource=admin",
    );
  });

  it("keeps the mongodb+srv scheme and existing options", () => {
    const out = scopedConnString(
      "mongodb+srv://root:pw@cluster0.abc.mongodb.net/?retryWrites=true",
      "idx_a",
      "pw",
    );
    expect(out).toBe(
      "mongodb+srv://idx_a:pw@cluster0.abc.mongodb.net/?retryWrites=true&authSource=admin",
    );
  });

  it("adds credentials when the admin string had none", () => {
    const out = scopedConnString("mongodb://localhost:27017", "idx_a", "pw");
    expect(out).toBe("mongodb://idx_a:pw@localhost:27017/?authSource=admin");
  });
});

describe("ENGINE_PRIVILEGES", () => {
  it("never grants document reads on customer collections", () => {
    const allCollections = ENGINE_PRIVILEGES.find(
      (privilege) =>
        "db" in privilege.resource &&
        privilege.resource.db === "" &&
        privilege.resource.collection === "",
    );
    expect(allCollections).toBeDefined();
    expect(allCollections?.actions).not.toContain("find");
    expect(allCollections?.actions).not.toContain("insert");
    expect(allCollections?.actions).not.toContain("remove");
  });

  it("grants find only on metadata namespaces (profiler, shard config)", () => {
    for (const privilege of ENGINE_PRIVILEGES) {
      if (!privilege.actions.includes("find")) continue;
      expect("db" in privilege.resource).toBe(true);
      if ("db" in privilege.resource) {
        const { db, collection } = privilege.resource;
        expect(collection === "system.profile" || db === "config").toBe(true);
      }
    }
  });
});

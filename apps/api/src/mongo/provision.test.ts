import { describe, expect, it } from "vitest";
import {
  alreadyProvisionedMessage,
  dropUserStatement,
  ENGINE_PRIVILEGES,
  SCOPED_USERNAME,
  scopedConnString,
} from "./provision";

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

describe("SCOPED_USERNAME", () => {
  // Fixed rather than random, which is what stops a cluster collecting one
  // abandoned user per connect — nothing here can drop them, because the admin
  // credentials that could are thrown away by design.
  it("is one fixed name, not a per-provision one", () => {
    expect(SCOPED_USERNAME).toBe("indexterity");
  });
});

describe("alreadyProvisionedMessage", () => {
  // The server cannot tell the two apart, so the sentence has to carry both: a
  // cluster somebody is adding twice, and one whose user outlived its
  // connection. Only the second needs the statement, and without it that case is
  // a dead end — provisioning would be unreachable on that cluster forever.
  it("names the user, the likely cause, and the way out of the other one", () => {
    const message = alreadyProvisionedMessage(dropUserStatement(SCOPED_USERNAME));
    expect(message).toContain(`"${SCOPED_USERNAME}"`);
    expect(message).toMatch(/already connected/i);
    expect(message).toContain('db.getSiblingDB("admin").dropUser("indexterity")');
  });
});

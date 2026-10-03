import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseInaccessibleError } from "../src/engine/ports";
import { present } from "../src/errors/at";
import { MongoIndexCollector } from "../src/mongo/collector";
import { MongoConnection } from "../src/mongo/connection";
import { privilegesOnConnection } from "../src/mongo/diagnose";
import { scopedConnString, upgradeEngineRole } from "../src/mongo/provision";
import { ENGINE_PRIVILEGES, ENGINE_ROLE } from "../src/mongo/role";

// Adapter-level integration against a mongod with AUTHENTICATION ON, which is
// the state the rest of the mongo integration coverage cannot reach: the server
// the api suite dials has auth disabled, and without auth there is no such thing
// as a database these credentials cannot read.
//
// Skipped without MONGO_ADMIN_URL — locally:
//   podman run -d --name mongoint -p 27018:27017 \
//     -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=probe \
//     docker.io/library/mongo:7.0
//   MONGO_ADMIN_URL='mongodb://root:probe@127.0.0.1:27018' \
//     npm run test:int -w apps/api -- integration/mongo.int.test.ts
const MONGO_ADMIN_URL = process.env.MONGO_ADMIN_URL;

const READABLE = "indexterity_int_app";
const LOCKED = "indexterity_int_locked";
const ROLE = "indexterityIntLister";
const USER = "indexterity_int_partial";

describe.skipIf(MONGO_ADMIN_URL === undefined)(
  "mongo adapter against an authenticated server",
  () => {
    let admin: MongoClient;
    let partial: MongoConnection;
    let collector: MongoIndexCollector;

    beforeAll(async () => {
      admin = new MongoClient(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"));
      await admin.connect();
      await cleanup();
      // Something to read in each, so an empty list can never be mistaken for a
      // refusal — which is the distinction this whole test is about.
      await admin.db(READABLE).collection("widgets").insertOne({ n: 1 });
      await admin.db(LOCKED).collection("widgets").insertOne({ n: 1 });
      // The shape a customer's own scoped user has: it can LIST the cluster's
      // databases and read only some of them. `listDatabases` is a cluster action
      // and it is what makes the difference visible — without it the server filters
      // the list down to the authorized databases and the unreadable one never
      // appears at all (measured on 7.0).
      await admin.db("admin").command({
        createRole: ROLE,
        privileges: [{ resource: { cluster: true }, actions: ["listDatabases"] }],
        roles: [],
      });
      await admin.db("admin").command({
        createUser: USER,
        pwd: "probe",
        roles: [
          { role: ROLE, db: "admin" },
          { role: "readWrite", db: READABLE },
        ],
      });
      partial = new MongoConnection(
        scopedConnString(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"), USER, "probe"),
      );
      await partial.connect();
      collector = new MongoIndexCollector(partial);
    }, 60_000);

    afterAll(async () => {
      await partial?.close().catch(() => {});
      await cleanup();
      await admin?.close().catch(() => {});
    });

    async function cleanup(): Promise<void> {
      await admin
        .db("admin")
        .command({ dropUser: USER })
        .catch(() => {});
      await admin
        .db("admin")
        .command({ dropRole: ROLE })
        .catch(() => {});
      for (const database of [READABLE, LOCKED]) {
        await admin
          .db(database)
          .dropDatabase()
          .catch(() => {});
      }
    }

    // #345. Existence is not access here either: the cluster names the database and
    // then refuses every read of it, so the collect and suggest passes above the
    // collector need the failure to arrive as DatabaseInaccessibleError — that type
    // alone is what they branch on to skip a database and keep walking.
    it("classifies a database it can list and cannot read", async () => {
      expect(await partial.listDatabaseNames()).toContain(LOCKED);
      await expect(collector.listCollectionNames(LOCKED)).rejects.toBeInstanceOf(
        DatabaseInaccessibleError,
      );
      await expect(collector.listCollectionNames(LOCKED)).rejects.toMatchObject({
        database: LOCKED,
      });
    }, 60_000);

    // The other half: the refusal is about that database and nothing else, so the
    // one the credentials DO cover still reads normally.
    it("keeps reading the database it is granted", async () => {
      expect(await collector.listCollectionNames(READABLE)).toContain("widgets");
    }, 60_000);
  },
);

// Upgrading the role Indexterity provisioned with an admin string used once
// (#599), against a server that enforces who may change a role. What it takes is
// measured, not assumed: userAdminAnyDatabase does it, and the role actions on
// `admin` alone do not, because the role's privileges reach every database.
describe.skipIf(MONGO_ADMIN_URL === undefined)("upgrading the provisioned role", () => {
  let admin: MongoClient;
  const ROLE_ADMIN_ONLY = "indexterityIntRoleAdminOnly";
  const ADMIN_ONLY = "indexterity_int_role_admin_only";
  const ANY_DB = "indexterity_int_role_any_db";
  const ACTIONS = ["viewRole", "grantRole", "revokeRole"];

  const asUser = (user: string) =>
    scopedConnString(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"), user, "probe");
  const actionsOfEngineRole = async (): Promise<string[]> => {
    const info = await admin.db("admin").command({ rolesInfo: ENGINE_ROLE, showPrivileges: true });
    const roles: unknown = info.roles;
    const first: unknown = Array.isArray(roles) ? roles[0] : undefined;
    const privileges: unknown =
      typeof first === "object" && first !== null ? Reflect.get(first, "privileges") : [];
    return (Array.isArray(privileges) ? privileges : []).flatMap((privilege: unknown) => {
      const actions: unknown =
        typeof privilege === "object" && privilege !== null
          ? Reflect.get(privilege, "actions")
          : [];
      return Array.isArray(actions)
        ? actions.filter((a): a is string => typeof a === "string")
        : [];
    });
  };
  const cleanup = async () => {
    const adminDb = admin.db("admin");
    for (const user of [ADMIN_ONLY, ANY_DB])
      await adminDb.command({ dropUser: user }).catch(() => {});
    for (const role of [ROLE_ADMIN_ONLY, ENGINE_ROLE]) {
      await adminDb.command({ dropRole: role }).catch(() => {});
    }
  };

  beforeAll(async () => {
    admin = new MongoClient(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"));
    await admin.connect();
    await cleanup();
    const adminDb = admin.db("admin");
    // The role as 0.28.0 provisioned it: without enableProfiler.
    await adminDb.command({
      createRole: ENGINE_ROLE,
      privileges: ENGINE_PRIVILEGES.map((privilege) => ({
        resource: privilege.resource,
        actions: privilege.actions.filter((action) => action !== "enableProfiler"),
      })),
      roles: [],
    });
    await adminDb.command({
      createRole: ROLE_ADMIN_ONLY,
      privileges: [{ resource: { db: "admin", collection: "" }, actions: ACTIONS }],
      roles: [],
    });
    await adminDb.command({ createUser: ADMIN_ONLY, pwd: "probe", roles: [ROLE_ADMIN_ONLY] });
    await adminDb.command({ createUser: ANY_DB, pwd: "probe", roles: ["userAdminAnyDatabase"] });
  });

  afterAll(async () => {
    await cleanup();
    await admin.close();
  });

  it("is refused, with what it takes, to an admin whose role rights stop at admin", async () => {
    await expect(upgradeEngineRole(asUser(ADMIN_ONLY))).rejects.toThrow(
      /needs userAdminAnyDatabase/,
    );
    expect(await actionsOfEngineRole()).not.toContain("enableProfiler");
  }, 60_000);

  it("brings the role to today's privileges with userAdminAnyDatabase", async () => {
    await upgradeEngineRole(asUser(ANY_DB));
    expect(await actionsOfEngineRole()).toContain("enableProfiler");
  }, 60_000);
});

// What a live connection's credentials hold, asked without a new dial (#599) —
// the check that decides whether a cluster is told about a privilege at all.
// Atlas's atlasAdmin carries enableProfiler through dbAdminAnyDatabase, and a
// cluster on it must read as holding it, not as missing it.
describe.skipIf(MONGO_ADMIN_URL === undefined)("checking a live connection's privileges", () => {
  let admin: MongoClient;
  const LIKE_ATLAS_ADMIN = "indexterity_int_like_atlas_admin";
  const WITHOUT = "indexterity_int_without_profiler";
  const READ_ONLY_ROLE = "indexterityIntListOnly";

  const connectAs = async (user: string): Promise<MongoConnection> => {
    const conn = new MongoConnection(
      scopedConnString(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"), user, "probe"),
    );
    await conn.connect();
    return conn;
  };
  const profiler = async (user: string) => {
    const conn = await connectAs(user);
    try {
      const checks = await privilegesOnConnection(conn, null);
      return checks?.find((check) => check.key === "enableProfiler")?.granted ?? null;
    } finally {
      await conn.close();
    }
  };
  const cleanup = async () => {
    const adminDb = admin.db("admin");
    for (const user of [LIKE_ATLAS_ADMIN, WITHOUT]) {
      await adminDb.command({ dropUser: user }).catch(() => {});
    }
    await adminDb.command({ dropRole: READ_ONLY_ROLE }).catch(() => {});
  };

  beforeAll(async () => {
    admin = new MongoClient(present(MONGO_ADMIN_URL, "MONGO_ADMIN_URL"));
    await admin.connect();
    await cleanup();
    // A database to be judged against: anyDb checks need one in scope.
    await admin.db("indexterity_int_check").collection("widgets").insertOne({ n: 1 });
    const adminDb = admin.db("admin");
    await adminDb.command({
      createRole: READ_ONLY_ROLE,
      privileges: [
        { resource: { cluster: true }, actions: ["listDatabases"] },
        { resource: { db: "", collection: "" }, actions: ["listIndexes"] },
      ],
      roles: [],
    });
    await adminDb.command({
      createUser: LIKE_ATLAS_ADMIN,
      pwd: "probe",
      roles: ["dbAdminAnyDatabase", "clusterMonitor"],
    });
    await adminDb.command({ createUser: WITHOUT, pwd: "probe", roles: [READ_ONLY_ROLE] });
  });

  afterAll(async () => {
    await cleanup();
    await admin
      .db("indexterity_int_check")
      .dropDatabase()
      .catch(() => {});
    await admin.close();
  });

  it("finds enableProfiler held by dbAdminAnyDatabase, as atlasAdmin holds it", async () => {
    expect(await profiler(LIKE_ATLAS_ADMIN)).toBe(true);
  }, 60_000);

  it("finds it missing from a role without it", async () => {
    expect(await profiler(WITHOUT)).toBe(false);
  }, 60_000);
});

import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseInaccessibleError } from "../src/engine/ports";
import { MongoIndexCollector } from "../src/mongo/collector";
import { MongoConnection } from "../src/mongo/connection";
import { scopedConnString } from "../src/mongo/provision";

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
      admin = new MongoClient(MONGO_ADMIN_URL as string);
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
      partial = new MongoConnection(scopedConnString(MONGO_ADMIN_URL as string, USER, "probe"));
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

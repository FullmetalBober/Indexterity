#!/usr/bin/env node
// Block until every mongod named in the environment answers an authenticated
// ping, and fail the job loudly if one never does.
//
// CI declares its mongods as service containers, and GitHub starts the steps as
// soon as the containers are CREATED unless a health check says otherwise. The
// postgres service has one; the two mongo services had none, so a job could —
// and did — reach its first test before mongod was listening:
// `MongoServerSelectionError: connect ECONNREFUSED ::1:27018, 127.0.0.1:27018`,
// with 172 tests already green behind it.
//
// `mongo-auth` is the one that loses this race, and by construction. When
// MONGO_INITDB_ROOT_USERNAME is set the image's entrypoint boots a TEMPORARY
// mongod bound to loopback, creates the root user against it, shuts it down and
// only then starts the real server — so that container is unreachable from the
// host for longer than a bare one, and there is a window where it is not
// listening at all.
//
// Which is also why this is a step here rather than a `--health-cmd` on the
// service. A health check runs INSIDE the container, where the temporary
// loopback mongod answers exactly like the real one; one probe landing in that
// window marks the service healthy and the job starts anyway. From out here
// there is no such ambiguity — the port is published or it is not.
//
// An authenticated ping rather than a TCP connect, because "the socket is open"
// and "the root user exists" are different facts and the second is the one
// mongo.int.test.ts needs.
import { MongoClient } from "mongodb";

// Long enough for a cold `mongo-auth` to finish creating its root user and
// restart, short enough to fail before the job's own timeout — where the log
// would say nothing about which server was missing.
const TIMEOUT_MS = 120_000;
const RETRY_MS = 1_000;

// Whatever this job declared. Both suites read these same names, so a job that
// adds a third mongod gets it waited on by naming it here and nowhere else.
const urls = ["MONGO_URL", "MONGO_ADMIN_URL"]
  .map((name) => [name, process.env[name]] as const)
  .filter((entry): entry is readonly [string, string] => (entry[1] ?? "") !== "");

if (urls.length === 0) {
  console.error("wait-for-mongo: neither MONGO_URL nor MONGO_ADMIN_URL is set");
  process.exit(1);
}

async function ping(url: string): Promise<void> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 2_000 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } finally {
    await client.close().catch(() => {});
  }
}

for (const [name, url] of urls) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = "";
  for (;;) {
    try {
      await ping(url);
      console.log(`wait-for-mongo: ${name} ready`);
      break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      // The whole point is to fail with the reason rather than to hang until the
      // job's own timeout, where the log says nothing about which server it was.
      if (Date.now() >= deadline) {
        console.error(`wait-for-mongo: ${name} never became ready — ${last}`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

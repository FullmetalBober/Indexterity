import { randomBytes } from "node:crypto";
import { type Db, MongoServerError } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";
import { z } from "zod";
import type { ProvisionedUser, TlsOverrides } from "../engine/ports";
import {
  alreadyProvisionedMessage,
  ProvisionDeniedError,
  SCOPED_USERNAME,
} from "../engine/provision";
import { mongoClient } from "./client";

export const ENGINE_ROLE = "indexterityEngine";

interface RolePrivilege {
  readonly resource:
    | { readonly cluster: true }
    | { readonly db: string; readonly collection: string };
  readonly actions: readonly string[];
}

// Everything the engine ever runs, and nothing else. Notably absent: `find` on
// customer collections ({db:"",collection:""}), so the scoped user CANNOT read
// documents — the server enforces it. The only find grants are metadata
// namespaces: system.profile (query shapes for workload analysis) and
// config.collections (shard-key detection).
export const ENGINE_PRIVILEGES: readonly RolePrivilege[] = [
  // Un-transformed $queryStats needs BOTH queryStats actions (verified live on
  // mongo 8: queryStatsRead alone is Unauthorized).
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
    ],
  },
  { resource: { db: "", collection: "system.profile" }, actions: ["find"] },
  { resource: { db: "config", collection: "collections" }, actions: ["find"] },
];

function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === 13 || /not authorized|requires authentication/i.test(error.message))
  );
}

// The scoped user is already on the cluster. Distinct from the authorization
// refusal above because the remedy is the opposite one: nothing needs granting,
// something needs recognising.
function isDuplicateUserError(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === 51003 || error.code === 11000 || /already exists/i.test(error.message))
  );
}

// The mongo shell command that removes the scoped user. Handed over rather than
// run, here and on the disconnect screen, because dropping a user needs admin
// credentials this product deliberately does not keep.
//
// One statement and no database list: the user is created in `admin` with a role
// that spans the cluster, so there is nothing per-database to undo. It takes the
// port's second parameter and ignores it so the three adapters answer one
// signature (#338).
export function dropUserStatement(username: string, _databases: readonly string[] = []): string {
  return `db.getSiblingDB("admin").dropUser("${username}")`;
}

// The username a connection string authenticates as, or null (no credentials /
// unparseable). Used by rotation to decide whether the stored scoped-user
// marker still describes the new string.
export function connStringUsername(uri: string): string | null {
  try {
    const username = new ConnectionString(uri).username;
    return username.length === 0 ? null : decodeURIComponent(username);
  } catch {
    return null;
  }
}

// Rewrite the admin connection string for the scoped user: same scheme, hosts
// and options, our credentials, authSource forced to admin (where the user
// lives). Pure — unit-tested against srv/multi-host/param-carrying strings.
export function scopedConnString(adminUri: string, username: string, password: string): string {
  const cs = new ConnectionString(adminUri);
  cs.username = username;
  cs.password = password;
  cs.searchParams.set("authSource", "admin");
  return cs.toString();
}

function withoutQueryStats(privileges: readonly RolePrivilege[]): readonly RolePrivilege[] {
  return privileges
    .map((privilege) => ({
      ...privilege,
      actions: privilege.actions.filter((name) => !name.startsWith("queryStats")),
    }))
    .filter((privilege) => privilege.actions.length > 0);
}

const rolesInfoResult = z.object({ roles: z.array(z.unknown()) });
const usersInfoResult = z.object({ users: z.array(z.unknown()) });

// Is the scoped user already here? Asked BEFORE anything is created, so a
// cluster that is already connected is refused without leaving a freshly
// upserted role behind it. `usersInfo` needs viewUser; credentials that lack it
// answer "no" and fall through to createUser, which refuses the duplicate
// itself — the check is an earlier, cleaner failure, never the only one.
async function scopedUserExists(admin: Db): Promise<boolean> {
  try {
    const info = usersInfoResult.parse(
      await admin.command({ usersInfo: { user: SCOPED_USERNAME, db: "admin" } }),
    );
    return info.users.length > 0;
  } catch {
    return false;
  }
}

// Create the engine role, or refresh its privileges when it already exists —
// re-provisioning after an app update picks up newly needed (or dropped) actions.
async function upsertEngineRole(admin: Db): Promise<void> {
  const info = rolesInfoResult.parse(await admin.command({ rolesInfo: ENGINE_ROLE }));
  const command = info.roles.length > 0 ? "updateRole" : "createRole";
  try {
    await admin.command({ [command]: ENGINE_ROLE, privileges: [...ENGINE_PRIVILEGES], roles: [] });
  } catch (error) {
    // mongo <7 rejects the queryStats* actions — the engine then degrades to
    // its profiler fallback, so provision without them rather than failing.
    if (error instanceof MongoServerError && error.message.includes("queryStatsRead")) {
      await admin.command({
        [command]: ENGINE_ROLE,
        privileges: [...withoutQueryStats(ENGINE_PRIVILEGES)],
        roles: [],
      });
      return;
    }
    throw error;
  }
}

// Use an admin connection string ONCE to create a least-privilege user the
// engine will run as, and return that user's connection string. The admin
// string is never stored; a failed verification drops the user again.
//
// Takes no observe selection, and neither does the MSSQL provisioner — same
// decision on both engines (#244). A role written at provision time is FROZEN
// while the selection is editable forever, so a user granted only where the
// selection pointed would silently lack listIndexes on the database somebody ticks
// six months later, with no admin string left to re-grant with.
//
// It would also buy very little here. The role above grants metadata actions
// through `{db: "", collection: ""}` and explicitly withholds `find` on customer
// collections, so a database outside the selection is one we can list indexes on
// and still cannot read a document from.
export async function provisionScopedUser(
  adminUri: string,
  overrides?: TlsOverrides,
): Promise<ProvisionedUser> {
  const username = SCOPED_USERNAME;
  const password = randomBytes(24).toString("base64url");
  const adminClient = mongoClient(adminUri, overrides);
  try {
    const admin = adminClient.db("admin");
    if (await scopedUserExists(admin)) {
      throw new ProvisionDeniedError(alreadyProvisionedMessage(dropUserStatement(username)));
    }
    try {
      await upsertEngineRole(admin);
      await admin.command({
        createUser: username,
        pwd: password,
        roles: [{ role: ENGINE_ROLE, db: "admin" }],
      });
    } catch (error) {
      if (isDuplicateUserError(error)) {
        throw new ProvisionDeniedError(alreadyProvisionedMessage(dropUserStatement(username)));
      }
      if (isAuthorizationError(error)) {
        throw new ProvisionDeniedError(
          "these credentials cannot create roles/users on the cluster " +
            "(Atlas manages users via its own UI/API) — create the scoped user there " +
            "and connect with its string instead",
        );
      }
      throw error;
    }
    const connectionString = scopedConnString(adminUri, username, password);
    // Prove the scoped credentials authenticate before storing anything.
    const probe = mongoClient(connectionString, overrides);
    try {
      await probe.db("admin").command({ ping: 1 });
    } catch (error) {
      await admin.command({ dropUser: username }).catch(() => {});
      throw error;
    } finally {
      await probe.close();
    }
    return { connectionString, username, databases: [] };
  } finally {
    await adminClient.close();
  }
}

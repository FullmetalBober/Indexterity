import { randomBytes } from "node:crypto";
import { type Db, MongoServerError } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";
import { z } from "zod";
import type { ProvisionedUser } from "../engine/ports";
import { mongoClient, type TlsOverrides } from "./client";

export const ENGINE_ROLE = "indexterityEngine";

// The scoped user's name — one fixed string on every engine, not a random
// `idx_<hex>` per provision. Two things follow from that, and the second is the
// reason it changed.
//
// It stops the cluster accumulating users. Provisioning creates a user with
// admin credentials we then throw away, so nothing here can ever drop one:
// connect, disconnect, connect again, and a random name left three logins behind
// for an operator to find months later and be unable to attribute.
//
// And it makes the cluster itself the guard against connecting the same database
// twice. The second provision asks to create a user that is already there and is
// refused BY THE SERVER — no uniqueness rule invented over connection strings
// that can spell one server a dozen ways (srv vs seed list, alias vs IP, with or
// without a database, any ordering of options). The name is the identity.
//
// Only the password is generated. Re-provisioning after a real offboard is
// therefore drop-then-provision, which is the command the disconnect screen
// already hands over.
export const SCOPED_USERNAME = "indexterity";

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

// The admin credentials lack createRole/createUser on this cluster (Atlas, for
// one, only manages users through its own UI/API). Surfaced as a 422.
export class ProvisionDeniedError extends Error {}

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
export function dropUserStatement(username: string): string {
  return `db.getSiblingDB("admin").dropUser("${username}")`;
}

// What a second provision against the same server is told, shared by all three
// engines. It states both readings because the server cannot tell them apart:
// either this database is already connected to Indexterity, or an earlier
// connection was removed and the user outlived it. Naming the drop statement is
// what keeps the second case from being a dead end — provisioning is otherwise
// unreachable forever on a cluster carrying an orphan.
export function alreadyProvisionedMessage(dropCommand: string): string {
  return (
    `this cluster already has an Indexterity user called "${SCOPED_USERNAME}", so it is ` +
    "already connected here — open that cluster instead of adding the same one twice. " +
    "If it was disconnected and the user was left behind, remove it with " +
    `${dropCommand} and provision again.`
  );
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
    return { connectionString, username };
  } finally {
    await adminClient.close();
  }
}

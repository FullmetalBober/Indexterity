import { randomBytes } from "node:crypto";
import { type Db, MongoServerError } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";
import { z } from "zod";
import type { DialProxy, ProvisionedUser, TlsOverrides } from "../engine/ports";
import {
  alreadyProvisionedMessage,
  ProvisionDeniedError,
  SCOPED_USERNAME,
} from "../engine/provision";
import { mongoClient } from "./client";
import { isAuthorizationError } from "./errors";
import { ENGINE_PRIVILEGES, ENGINE_ROLE, type RolePrivilege } from "./role";

// The scoped user is already on the cluster. Distinct from the authorization
// refusal in ./errors because the remedy is the opposite one: nothing needs
// granting, something needs recognising.
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
  // Route the admin dial through a tunnel when the cluster needs one (#353).
  proxy?: DialProxy,
): Promise<ProvisionedUser> {
  const username = SCOPED_USERNAME;
  const password = randomBytes(24).toString("base64url");
  const adminClient = mongoClient(adminUri, overrides, proxy);
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
    // The probe verifies the user we just made, so it goes the same way.
    const probe = mongoClient(connectionString, overrides, proxy);
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

// Bring the role Indexterity provisioned up to today's definition, with an admin
// string used ONCE and never stored — the same terms provisioning runs on (#599).
//
// `updateRole` rather than a grant of what changed: it REPLACES the privileges,
// so the role ends exactly as a cluster provisioned today would have it — every
// action a release added, and none a release dropped. Anything an owner granted
// to this role by hand goes with it; the role is ours, and documented as this
// set and nothing else.
//
// What it takes, measured on 7.0.39 against today's role: userAdminAnyDatabase,
// or viewRole, grantRole and revokeRole on `anyResource`. The same three on
// `{db: "", collection: ""}` are refused — that resource leaves out `config`, and
// the role reads `config.collections` — and userAdmin on `admin` is refused too.
//
// Refuses a cluster with no such role rather than creating one: a role nobody
// holds would be a grant with no purpose, and the cluster in front of the owner
// is connected some other way.
export async function upgradeEngineRole(
  adminUri: string,
  overrides?: TlsOverrides,
  proxy?: DialProxy,
): Promise<void> {
  const adminClient = mongoClient(adminUri, overrides, proxy);
  try {
    const admin = adminClient.db("admin");
    try {
      const info = rolesInfoResult.parse(await admin.command({ rolesInfo: ENGINE_ROLE }));
      if (info.roles.length === 0) {
        throw new ProvisionDeniedError(
          `there is no ${ENGINE_ROLE} role on this cluster to upgrade — the admin string ` +
            "may point at a different cluster than the one Indexterity provisioned",
        );
      }
      await upsertEngineRole(admin);
    } catch (error) {
      if (isAuthorizationError(error)) {
        throw new ProvisionDeniedError(
          `these credentials cannot change roles on the cluster — upgrading ${ENGINE_ROLE} ` +
            "needs userAdminAnyDatabase, or viewRole, grantRole and revokeRole on every " +
            "database including config, because the role's privileges reach all of them",
        );
      }
      throw error;
    }
  } finally {
    await adminClient.close();
  }
}

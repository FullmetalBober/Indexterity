import { randomBytes } from "node:crypto";
import { type Db, MongoClient, MongoServerError } from "mongodb";
import ConnectionString from "mongodb-connection-string-url";
import { z } from "zod";

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
    actions: ["listDatabases", "queryStatsRead", "queryStatsReadTransformed"],
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

export interface ProvisionedUser {
  readonly connectionString: string;
  readonly username: string;
}

// The admin credentials lack createRole/createUser on this cluster (Atlas, for
// one, only manages users through its own UI/API). Surfaced as a 422.
export class ProvisionDeniedError extends Error {}

function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === 13 || /not authorized|requires authentication/i.test(error.message))
  );
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
export async function provisionScopedUser(adminUri: string): Promise<ProvisionedUser> {
  const username = `idx_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const adminClient = new MongoClient(adminUri, { serverSelectionTimeoutMS: 5000 });
  try {
    const admin = adminClient.db("admin");
    try {
      await upsertEngineRole(admin);
      await admin.command({
        createUser: username,
        pwd: password,
        roles: [{ role: ENGINE_ROLE, db: "admin" }],
      });
    } catch (error) {
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
    const probe = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000 });
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

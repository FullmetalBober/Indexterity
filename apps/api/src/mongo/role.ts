// The role Indexterity provisions on MongoDB, and every way it has changed (#599).
//
// A role is created once, from an admin string that is never stored, so a
// release that asks for one more action cannot add it to roles already out
// there. What it can do is know exactly what changed and when: the role is its
// BASE plus a list of changes, each stamped with the release that asked for it,
// and a cluster records how far along that list its credentials are
// (`clusters.privileges_revision`). That is what tells a cluster it lacks
// something, hands its owner the one statement that grants it, and lets the role
// be upgraded with an admin string used once.

export const ENGINE_ROLE = "indexterityEngine";

export interface RolePrivilege {
  readonly resource:
    | { readonly cluster: true }
    | { readonly db: string; readonly collection: string };
  readonly actions: readonly string[];
}

// The role as the first release provisioned it, and every release up to 0.28.0
// after it — `serverStatus` arrived the day before v0.1.0 was cut, so no
// released role ever lacked it.
//
// Notably absent: `find` on customer collections ({db:"",collection:""}), so the
// scoped user CANNOT read documents — the server enforces it. The only find
// grants are metadata namespaces: system.profile (query shapes for workload
// analysis) and config.collections (shard-key detection).
const BASE_PRIVILEGES: readonly RolePrivilege[] = [
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

// One privilege a release added after the base.
export interface RoleChange {
  // 1, 2, 3 … in order: how far along this list a cluster's credentials are.
  readonly revision: number;
  // The release that first asked for it, which is how an owner is told ("new in").
  readonly release: string;
  // The diagnose check that reports it (mongo/diagnose.ts), whose label and
  // `enables` say what it is for. Its tier is WORKLOAD — a privilege added later is
  // always optional, so a cluster without it loses that one feature and nothing
  // else (role.test.ts holds every change to it).
  readonly check: string;
  readonly grant: RolePrivilege;
}

// Every change, oldest first. Adding a privilege to the role MEANS adding an
// entry here: ENGINE_PRIVILEGES is derived from this list, so there is no other
// way in, and a cluster connected before it is told.
export const ROLE_CHANGES: readonly RoleChange[] = [
  {
    revision: 1,
    release: "0.29.0",
    check: "enableProfiler",
    // Turning the profiler on for a hidden index's observe window, so a query the
    // hide breaks is seen failing (#596). Reading its settings needs none.
    grant: { resource: { db: "", collection: "" }, actions: ["enableProfiler"] },
  },
];

function sameResource(a: RolePrivilege["resource"], b: RolePrivilege["resource"]): boolean {
  if ("cluster" in a || "cluster" in b) return "cluster" in a && "cluster" in b;
  return a.db === b.db && a.collection === b.collection;
}

// The base with these changes folded in: each change's actions join the grant on
// the same resource, or become a grant of their own.
function withChanges(
  base: readonly RolePrivilege[],
  changes: readonly RoleChange[],
): readonly RolePrivilege[] {
  const out = base.map((privilege) => ({
    resource: privilege.resource,
    actions: [...privilege.actions],
  }));
  for (const { grant } of changes) {
    const same = out.find((privilege) => sameResource(privilege.resource, grant.resource));
    if (same === undefined) {
      out.push({ resource: grant.resource, actions: [...grant.actions] });
      continue;
    }
    for (const action of grant.actions) {
      if (!same.actions.includes(action)) same.actions.push(action);
    }
  }
  return out;
}

// Everything the engine ever runs, and nothing else — the role as provisioned
// today.
export const ENGINE_PRIVILEGES: readonly RolePrivilege[] = withChanges(
  BASE_PRIVILEGES,
  ROLE_CHANGES,
);

// The statement that grants the role what changed after `revision`, for an owner
// to run as an admin — or null when nothing did. A runnable command with nothing
// left blank, because the role is ours and so is its name; a role somebody made
// by hand gets no command at all, for #246's reason.
export function grantChangesStatement(revision: number): string | null {
  const grants = ROLE_CHANGES.filter((change) => change.revision > revision).map(
    (change) => change.grant,
  );
  if (grants.length === 0) return null;
  return `db.getSiblingDB("admin").grantPrivilegesToRole("${ENGINE_ROLE}", ${JSON.stringify(grants)})`;
}

import type { Admin } from "mongodb";
import { z } from "zod";
import { scopeForDiagnosis } from "../engine/observe";
import type {
  ConnectionDiagnosis,
  PrivilegeCheck,
  PrivilegeTier,
  TlsOverrides,
} from "../engine/ports";
import { mongoClient } from "./client";
import { ENGINE_ROLE } from "./provision";
import {
  hasQueryStatsPlanMetrics,
  parseServerVersion,
  type ServerVersion,
  versionRefusal,
} from "./version";

// What the engine needs, expressed as (actions, where) pairs. Mirrors
// ENGINE_PRIVILEGES in provision.ts — the role we CREATE is exactly the set we
// CHECK for, so a provisioned cluster always diagnoses clean.
interface RequiredPrivilege {
  readonly key: string;
  readonly label: string;
  readonly enables: string;
  readonly tier: PrivilegeTier;
  readonly actions: readonly string[];
  // "cluster" = cluster-wide action; "anyDb" = needed on every user database
  // (optionally narrowed to one collection); "exact" = one fixed namespace.
  readonly scope:
    | { readonly kind: "cluster" }
    | { readonly kind: "anyDb"; readonly collection?: string }
    | { readonly kind: "exact"; readonly db: string; readonly collection: string };
}

export const REQUIRED_PRIVILEGES: readonly RequiredPrivilege[] = [
  {
    key: "listDatabases",
    label: "List databases",
    enables: "finding which databases to analyze",
    tier: "CORE",
    actions: ["listDatabases"],
    scope: { kind: "cluster" },
  },
  {
    key: "listCollections",
    label: "List collections",
    enables: "finding collections inside each database",
    tier: "CORE",
    actions: ["listCollections"],
    scope: { kind: "anyDb" },
  },
  {
    key: "listIndexes",
    label: "List indexes",
    enables: "reading index specs (keys, uniqueness, collation)",
    tier: "CORE",
    actions: ["listIndexes"],
    scope: { kind: "anyDb" },
  },
  {
    key: "indexStats",
    label: "Index usage stats ($indexStats)",
    enables: "usage counters — the whole drop decision rests on these",
    tier: "CORE",
    actions: ["indexStats"],
    scope: { kind: "anyDb" },
  },
  {
    key: "collStats",
    label: "Collection stats ($collStats)",
    enables: "sizes, document counts and read/write latency — ROI and the regression gates",
    tier: "CORE",
    actions: ["collStats"],
    scope: { kind: "anyDb" },
  },
  {
    key: "collMod",
    label: "Hide/unhide indexes (collMod)",
    enables: "the reversible hide step before any drop",
    tier: "APPLY",
    actions: ["collMod"],
    scope: { kind: "anyDb" },
  },
  {
    key: "dropIndex",
    label: "Drop indexes",
    enables: "removing an index after it survives the observe window",
    tier: "APPLY",
    actions: ["dropIndex"],
    scope: { kind: "anyDb" },
  },
  {
    key: "createIndex",
    label: "Create indexes",
    enables: "building recommended indexes and undoing a drop",
    tier: "APPLY",
    actions: ["createIndex"],
    scope: { kind: "anyDb" },
  },
  {
    key: "queryStats",
    label: "Query stats ($queryStats)",
    enables: "workload analysis without the profiler (full detail on mongo 8.0+)",
    tier: "WORKLOAD",
    actions: ["queryStatsRead", "queryStatsReadTransformed"],
    scope: { kind: "cluster" },
  },
  {
    key: "serverStatus",
    label: "Server status",
    enables:
      "the five-minute health probe (collection scans, lock queues) — " +
      "note this also exposes connection counts, network totals and storage-engine internals",
    tier: "WORKLOAD",
    actions: ["serverStatus"],
    scope: { kind: "cluster" },
  },
  {
    key: "profiler",
    label: "Read system.profile",
    enables: "workload analysis fallback, partial-index and TTL detection",
    tier: "WORKLOAD",
    actions: ["find"],
    scope: { kind: "anyDb", collection: "system.profile" },
  },
  {
    key: "shardConfig",
    label: "Read config.collections",
    enables: "shard-key detection on sharded clusters",
    tier: "WORKLOAD",
    actions: ["find"],
    scope: { kind: "exact", db: "config", collection: "collections" },
  },
];

// What it takes to create the scoped user for the reader, expressed in the same
// shape as everything above so it lands in the same list on screen.
//
// These used to be three bare action names collapsed into one boolean, and the
// boolean was all the dashboard had: when it came back false the connect form
// said nothing at all, so a user that genuinely cannot create users and a
// diagnosis that could not tell were the same blank space (#86). Named checks
// mean the form can say which action is missing, and the reader can see for
// themselves that we asked.
//
// `admin` because that is where the role and the user are created
// (provision.ts); a wildcard `{db:"",collection:""}` grant — what
// userAdminAnyDatabase and root carry — matches it via grantsNamespace.
export const PROVISION_PRIVILEGES: readonly RequiredPrivilege[] = [
  {
    key: "createRole",
    label: "Create a role (createRole)",
    enables: `defining the ${ENGINE_ROLE} role that scopes the user`,
    tier: "PROVISION",
    actions: ["createRole"],
    scope: { kind: "exact", db: "admin", collection: "" },
  },
  {
    key: "createUser",
    label: "Create a user (createUser)",
    enables: "creating the `indexterity` user Indexterity would run as",
    tier: "PROVISION",
    actions: ["createUser"],
    scope: { kind: "exact", db: "admin", collection: "" },
  },
  {
    key: "grantRole",
    label: "Grant a role (grantRole)",
    enables: "attaching that role to that user",
    tier: "PROVISION",
    actions: ["grantRole"],
    scope: { kind: "exact", db: "admin", collection: "" },
  },
];

const rateLimitDoc = z.object({ internalQueryStatsRateLimit: z.coerce.number() });

// Holding the $queryStats privilege is not the same as the store having
// anything in it. `internalQueryStatsRateLimit` is 0 on a stock server of every
// version, and at 0 the server records nothing — so the grant can look perfect
// while the store stays permanently empty, and nobody would know why.
//
// Returns the advisory to show, or null when there is nothing to say. -1 means
// record everything; any positive value is a per-second sampling cap. `null`
// sampling means the parameter could not be read, which is not evidence either
// way. Pure, so the wording is testable without a server.
export function queryStatsAdvisory(
  sampling: number | null,
  version: ServerVersion | null,
): string | null {
  if (sampling === null) return null;
  if (sampling === 0) {
    return (
      "$queryStats is available but not sampling — internalQueryStatsRateLimit is 0, the " +
      "default, so the server records no query shapes. Set it (-1 records every shape) or " +
      "enable the profiler; otherwise index suggestions have no workload to read."
    );
  }
  if (!hasQueryStatsPlanMetrics(version)) {
    return (
      `$queryStats on MongoDB ${version?.text ?? "this release"} reports execution counts only — ` +
      "it cannot say whether a query scanned or sorted in memory, which is what index " +
      "suggestions are made of. Enable the profiler on the databases you want analyzed, or " +
      "upgrade to 8.0 where the store carries plan metrics."
    );
  }
  return null;
}

// The parameter is unreadable without the cluster-wide `getParameter` action,
// which is not one the engine asks for. Silence is the honest answer then.
async function readQueryStatsSampling(admin: Admin): Promise<number | null> {
  try {
    const raw = await admin.command({ getParameter: 1, internalQueryStatsRateLimit: 1 });
    return rateLimitDoc.parse(raw).internalQueryStatsRateLimit;
  } catch {
    return null;
  }
}

const privilegeDoc = z.object({
  resource: z.object({
    db: z.string().optional(),
    collection: z.string().optional(),
    cluster: z.boolean().optional(),
    anyResource: z.boolean().optional(),
  }),
  actions: z.array(z.string()),
});
export type MongoPrivilege = z.infer<typeof privilegeDoc>;

// The roles a user holds by NAME, which `connectionStatus` returns whether or
// not privileges were asked for. Read alongside the resolved privilege list
// because the two answer different questions: the privileges say what is
// permitted, the role names say what a `revokeRolesFromUser` can take away
// (#313). A resolved action cannot be revoked — only the grant that produced it
// can — so a surplus finding without the role name is a finding with no remedy.
const roleDoc = z.object({ role: z.string(), db: z.string() });
export type MongoRole = z.infer<typeof roleDoc>;

const connectionStatusDoc = z.object({
  authInfo: z.object({
    authenticatedUsers: z.array(z.object({ user: z.string(), db: z.string() })),
    authenticatedUserRoles: z.array(roleDoc).optional(),
    authenticatedUserPrivileges: z.array(privilegeDoc).optional(),
  }),
});

// The built-in roles that hold more than the engine ever uses, and what each of
// them is (#313).
//
// Every one is a role somebody grants on purpose, so every one can be revoked by
// name — which is what makes this list worth having rather than reporting the
// resolved actions. `dbAdminAnyDatabase` is here for the same reason as the rest
// even though the issue's list stops at four: it carries collMod and dropIndex
// across every database plus `dropDatabase`, and a reader shown three of their
// four broad roles would reasonably conclude the fourth is required.
//
// Ordered widest first, so a `root` grant is the first thing on the card.
const SURPLUS_ROLES: readonly { readonly role: string; readonly holds: string }[] = [
  {
    role: "root",
    holds:
      "everything on the deployment — reading and rewriting every document, and creating users",
  },
  {
    role: "userAdminAnyDatabase",
    holds:
      "creating and altering users and roles on every database, which is how any grant is made",
  },
  {
    role: "readWriteAnyDatabase",
    holds: "reading and writing every document on every database",
  },
  {
    role: "dbOwner",
    holds: "reading, writing and administering everything in that database",
  },
  {
    role: "dbAdminAnyDatabase",
    holds:
      "administering every database — including dropping one — on top of the index actions the engine does use",
  },
];

// The three actions that change customer data. Nothing in the pipeline performs
// one: it lists, reads statistics, hides, drops and creates indexes. So holding
// any of them is surplus by definition on this engine, unlike on PostgreSQL where
// the apply path needs ownership and ownership carries reads.
const WRITE_ACTIONS = ["insert", "update", "remove"] as const;

function grantsCluster(privileges: readonly MongoPrivilege[], action: string): boolean {
  return privileges.some(
    (privilege) =>
      (privilege.resource.cluster === true || privilege.resource.anyResource === true) &&
      privilege.actions.includes(action),
  );
}

// Does any privilege cover this exact namespace? "" is mongo's wildcard for
// both db and collection, so {db:"", collection:""} covers everything.
function grantsNamespace(
  privileges: readonly MongoPrivilege[],
  action: string,
  db: string,
  collection: string,
): boolean {
  return privileges.some((privilege) => {
    if (!privilege.actions.includes(action)) return false;
    const resource = privilege.resource;
    if (resource.anyResource === true) return true;
    if (resource.db === undefined || resource.collection === undefined) return false;
    const dbMatches = resource.db === "" || resource.db === db;
    const collectionMatches = resource.collection === "" || resource.collection === collection;
    return dbMatches && collectionMatches;
  });
}

// One requirement against one privilege set. An "anyDb" requirement passes on a
// wildcard grant, or when every discovered user database is individually covered
// (a per-database role still works).
function grants(
  required: RequiredPrivilege,
  privileges: readonly MongoPrivilege[],
  userDatabases: readonly string[],
): boolean {
  return required.actions.every((action) => {
    if (required.scope.kind === "cluster") return grantsCluster(privileges, action);
    if (required.scope.kind === "exact") {
      return grantsNamespace(privileges, action, required.scope.db, required.scope.collection);
    }
    const collection = required.scope.collection ?? "";
    // "" as the probe db only matches a wildcard grant.
    if (grantsNamespace(privileges, action, "", collection)) return true;
    return (
      userDatabases.length > 0 &&
      userDatabases.every((db) => grantsNamespace(privileges, action, db, collection))
    );
  });
}

function toCheck(required: RequiredPrivilege, granted: boolean): PrivilegeCheck {
  return {
    key: required.key,
    label: required.label,
    enables: required.enables,
    tier: required.tier,
    granted,
    // No runnable fix to hand over here (#246). Every gap on this engine is closed
    // by granting a role on a user whose NAME this diagnosis does not always know —
    // and `enables` already links the exact role — so a command would be a template
    // with a blank in it, which is what the SQL Server side of #246 exists to
    // remove rather than to spread.
    command: null,
  };
}

// Pure evaluation — the live probe just feeds it. Exported for unit tests.
export function evaluatePrivileges(
  privileges: readonly MongoPrivilege[],
  userDatabases: readonly string[],
): PrivilegeCheck[] {
  return REQUIRED_PRIVILEGES.map((required) =>
    toCheck(required, grants(required, privileges, userDatabases)),
  );
}

// The provisioning half, evaluated the same way. No user databases are relevant:
// all three actions are asked for on `admin` exactly.
export function evaluateProvisioning(privileges: readonly MongoPrivilege[]): PrivilegeCheck[] {
  return PROVISION_PRIVILEGES.map((required) =>
    toCheck(required, grants(required, privileges, [])),
  );
}

// What this user holds and the engine never uses (#313).
//
// Two kinds of finding, and they are reported as separate rows because they have
// separate remedies:
//
//  - a built-in role held by name, which `revokeRolesFromUser` removes outright;
//  - write access to documents, which is what those roles MEAN and can also come
//    from a custom role this function cannot narrow for you.
//
// The write row's command is null whenever a role above already explains it. That
// is the "one problem named twice" rule the CONNECT check applies next door in
// PostgreSQL: the reader gets both facts — you can rewrite our documents, and
// here is the grant that lets you — with one statement between them, rather than
// the same revoke printed under two headings.
//
// `user` is the authenticated user AND the database it was created in, which is
// the one thing a revoke cannot be written without — and the database is not
// optional. `revokeRolesFromUser` resolves the user in the database it is issued
// against, so a user created in `app` is UserNotFound from `admin` (measured on
// 8.0: `Could not find user "owner" for db "admin"`). The common case is `admin`
// and every provisioned user is there; a customer's own application user very
// often is not.
//
// Null means the deployment has authentication disabled, and then nothing here is
// revocable at all — the surplus is the deployment, and the diagnosis's own
// message says so.
export function evaluateSurplus(
  roles: readonly MongoRole[],
  privileges: readonly MongoPrivilege[],
  userDatabases: readonly string[],
  user: { readonly user: string; readonly db: string } | null,
): PrivilegeCheck[] {
  const held = SURPLUS_ROLES.map((entry) => ({
    entry,
    // Every database it is held ON. `dbOwner` is per database and the other four
    // are admin-scoped, so this is what turns one name into the statement that
    // removes it — a `dbOwner` on two databases takes two revokes.
    on: roles.filter((role) => role.role === entry.role).map((role) => role.db),
  })).filter((candidate) => candidate.on.length > 0);

  const checks: PrivilegeCheck[] = held.map(({ entry, on }) => ({
    key: `surplus_${entry.role}`,
    label: on.length === 1 && on[0] === "admin" ? entry.role : `${entry.role} on ${on.join(", ")}`,
    enables: entry.holds,
    tier: "SURPLUS",
    granted: true,
    command: revokeRoles(user, [{ role: entry.role, on }]),
  }));

  // Asked against the databases in scope, like every anyDb requirement above: a
  // write grant on a database nobody asked us to observe is still surplus, but it
  // is not surplus we can name from a scope we were not given.
  const writeActions = WRITE_ACTIONS.filter((action) =>
    grants(
      {
        key: action,
        label: action,
        enables: action,
        tier: "SURPLUS",
        actions: [action],
        scope: { kind: "anyDb" },
      },
      privileges,
      userDatabases,
    ),
  );
  if (writeActions.length > 0) {
    checks.push({
      key: "surplus_write",
      label: `${writeActions.join(", ")} on the databases in scope`,
      enables:
        held.length > 0
          ? "changing the documents in your collections — which is what the role above carries. " +
            "Nothing in the pipeline writes a document: it lists, reads statistics, hides, drops " +
            "and creates indexes"
          : "changing the documents in your collections. Nothing in the pipeline writes a " +
            "document — it lists, reads statistics, hides, drops and creates indexes — so this " +
            "comes from a custom role, which only db.updateRole on that role can narrow",
      tier: "SURPLUS",
      granted: true,
      // Null when a role above carries it: the revoke is printed there, and
      // printing it twice under two headings is how a reader runs it once and
      // believes they have two things left to do.
      command: null,
    });
  }
  return checks;
}

// `db.revokeRolesFromUser`, ready to run, or null when there is nobody to run it
// against.
//
// Issued against the user's OWN database rather than `admin`, for the reason in
// the comment above `evaluateSurplus`. The roles keep their own `db` inside the
// call, which is a different question and is what makes a per-database `dbOwner`
// revocable at all: the user lives in one database, the role is held on another.
function revokeRoles(
  user: { readonly user: string; readonly db: string } | null,
  held: readonly { readonly role: string; readonly on: readonly string[] }[],
): string | null {
  if (user === null) return null;
  const roles = held.flatMap(({ role, on }) =>
    on.map((db) => `{ role: ${JSON.stringify(role)}, db: ${JSON.stringify(db)} }`),
  );
  if (roles.length === 0) return null;
  return (
    `db.getSiblingDB(${JSON.stringify(user.db)}).revokeRolesFromUser(` +
    `${JSON.stringify(user.user)}, [${roles.join(", ")}])`
  );
}

// Derived from the checks rather than computed a second way, so the offer the
// form makes and the reasons it shows can never disagree.
export function canProvisionWith(privileges: readonly MongoPrivilege[]): boolean {
  return evaluateProvisioning(privileges).every((check) => check.granted);
}

function summarize(
  privileges: PrivilegeCheck[],
  base: Omit<ConnectionDiagnosis, "privileges" | "ready" | "canApply" | "missing">,
): ConnectionDiagnosis {
  // CORE and APPLY only. WORKLOAD is an optional signal source, and PROVISION is
  // not a requirement at all — listing a missing `createUser` here would tell
  // someone connecting a perfectly good read-only user that something is wrong
  // with it, and would put it in createCluster's refusal message too.
  const missing = privileges
    .filter((check) => !check.granted && (check.tier === "CORE" || check.tier === "APPLY"))
    .map((check) => check.label);
  return {
    ...base,
    privileges,
    ready: privileges.filter((check) => check.tier === "CORE").every((check) => check.granted),
    canApply: privileges.filter((check) => check.tier === "APPLY").every((check) => check.granted),
    missing,
  };
}

// Every check at once, for the two cases where nothing was measured per-action:
// an unreachable cluster (all false) and a deployment with authentication
// disabled (all true — everything genuinely is permitted, including creating
// users; `canProvision` is still false there, because a dedicated user cannot be
// enforced against a server that asks for no credentials).
function allGranted(granted: boolean): PrivilegeCheck[] {
  return [...REQUIRED_PRIVILEGES, ...PROVISION_PRIVILEGES].map((required) =>
    toCheck(required, granted),
  );
}

function failure(message: string): ConnectionDiagnosis {
  return summarize(allGranted(false), {
    reachable: false,
    message,
    username: null,
    authEnabled: false,
    canProvision: false,
    // Nothing was enumerated, so nothing can be CLAIMED surplus either — empty
    // here means "we could not ask", not "there is none".
    surplus: [],
    // Nothing was enumerated, so there is nothing to offer boxes for — and an
    // unreachable cluster must not report the databases a previous answer found.
    databases: [],
  });
}

// Ask the cluster what these credentials may actually do, and translate it into
// "what works, what breaks, and what is missing". Uses connectionStatus
// (available to any authenticated user) rather than probing commands, so
// nothing is written just to find out.
export async function diagnoseConnection(
  uri: string,
  overrides?: TlsOverrides,
  // Which databases the answer is about (#244). Undefined and null both mean the
  // whole cluster, which is what the FIRST check always is — there is no list to
  // narrow to until this function has returned one.
  //
  // It changes the verdict, not just the work: the anyDb requirements below pass
  // when every database in scope is individually covered, so a role scoped to one
  // database reads as ungranted against a twelve-database cluster and as granted
  // against the one database somebody actually asked us to observe.
  observedDatabases?: readonly string[] | null,
): Promise<ConnectionDiagnosis> {
  const client = mongoClient(uri, overrides);
  try {
    const admin = client.db("admin");
    // Version first: below the floor nothing else matters, and saying so at
    // connect time is the difference between a clear refusal and a customer
    // discovering weeks later that drops silently never happen.
    //
    // The failure is deliberately NOT caught here. If buildInfo cannot run, the
    // reason is unreachable or unauthenticated, not old — and the catch below
    // says so precisely. Swallowing it would report a version problem for a
    // host that never answered.
    const build: unknown = await admin.command({ buildInfo: 1 });
    const version = parseServerVersion(
      typeof build === "object" && build !== null ? Reflect.get(build, "version") : null,
    );
    const refusal = versionRefusal(version);
    if (refusal !== null) return failure(refusal);
    const status = connectionStatusDoc.parse(
      await admin.command({ connectionStatus: 1, showPrivileges: true }),
    );
    const privileges = status.authInfo.authenticatedUserPrivileges ?? [];
    const roles = status.authInfo.authenticatedUserRoles ?? [];
    const user = status.authInfo.authenticatedUsers[0];

    let userDatabases: string[] = [];
    let listWorks = true;
    try {
      const result = await admin.admin().listDatabases();
      userDatabases = result.databases
        .map((entry) => entry.name)
        .filter((name) => name !== "admin" && name !== "local" && name !== "config");
    } catch {
      listWorks = false;
    }

    // Two lists, deliberately. `userDatabases` is what the cluster HAS and is what
    // the form draws boxes from — narrowing it would hide the databases the reader
    // has not ticked yet, so a selection could never be widened again. `inScope` is
    // what the verdict is ABOUT, and the rule that produces it is shared with the
    // MSSQL adapter (engine/observe.ts) so the two cannot answer the stale-selection
    // case differently.
    const inScope = scopeForDiagnosis(userDatabases, observedDatabases);

    if (user === undefined) {
      // No authenticated user. Either the deployment has auth disabled (in
      // which case everything is permitted) or the string simply has no
      // credentials for an auth-enforcing server.
      if (listWorks) {
        return summarize(allGranted(true), {
          reachable: true,
          message:
            "this deployment has authentication disabled — every privilege is available, " +
            "and a dedicated user could not be enforced. Enable auth before production use.",
          username: null,
          authEnabled: false,
          canProvision: false,
          // Every surplus grant there is, and not one of them revocable: there is
          // no user to revoke it FROM. Reported as empty with the message above
          // carrying the whole finding, because a list of rows whose commands are
          // all null would read as a to-do list nobody can act on. The surplus
          // here is the deployment, and `authEnabled: false` is how every screen
          // and the connect gate name it (#313).
          surplus: [],
          databases: userDatabases,
        });
      }
      return failure(
        "connected, but the string carries no credentials and the server requires them — " +
          "add a username and password.",
      );
    }

    const checks = evaluatePrivileges(privileges, inScope);
    // Reported alongside the engine's own, so whichever answer the form gives
    // about provisioning, the reader can see what it was read from.
    const provisioning = evaluateProvisioning(privileges);
    // Only worth saying when the credentials could read the store at all —
    // without the grant the profiler is the source regardless.
    const grantedQueryStats = checks.some((check) => check.key === "queryStats" && check.granted);
    const advisory = grantedQueryStats
      ? queryStatsAdvisory(await readQueryStatsSampling(admin.admin()), version)
      : null;
    return summarize([...checks, ...provisioning], {
      reachable: true,
      message: advisory,
      username: user.user,
      authEnabled: true,
      canProvision: provisioning.every((check) => check.granted),
      // Against the same scope the requirements were evaluated over: a write
      // grant is surplus on the databases we are asked to observe, and a scope we
      // were not given is one we cannot make a claim about.
      surplus: evaluateSurplus(roles, privileges, inScope, user),
      databases: userDatabases,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Authentication failed|AuthenticationFailed|bad auth/i.test(message)) {
      return failure("authentication failed — check the username and password.");
    }
    if (/getaddrinfo|ECONNREFUSED|ETIMEDOUT|Server selection timed out/i.test(message)) {
      return failure("cluster unreachable — check the host, port and network access.");
    }
    return failure(message);
  } finally {
    await client.close().catch(() => {});
  }
}

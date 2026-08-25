import type { IndexSpec, QueryShape, ServerHealth } from "./types";

// The engine-neutral boundary. Everything above this file — the analysis core,
// the job pipeline, the API — speaks these ports; everything below implements
// them per database engine. Three adapters implement them today (mongo/,
// postgres/, mssql/); what each maps onto is documented on the wiki's
// Architecture page under Engine ports (pg_stat_user_indexes /
// sys.dm_db_index_usage_stats etc.).
//
// The SHAPES these signatures are written in — IndexSpec, QueryShape,
// ServerHealth — are in ./types, and this file may not import from analysis/:
// depending on the layer above would describe the boundary in terms of its own
// consumer, and did, as a cycle (#330).
//
// Vocabulary is MongoDB-flavored on purpose ("collection", "database") — a
// relational adapter maps them (table, schema/database) rather than the whole
// codebase adopting a lowest-common-denominator vocabulary.

export type ClusterEngine = "MONGODB" | "POSTGRESQL" | "MSSQL";

// Which certificate checks a cluster's owner chose to turn off, as checkboxes on
// the connect form. Carried to every dial so the transport guard verifies
// against a recorded decision rather than against whatever the string says.
export interface TlsOverrides {
  readonly allowInvalidCertificates: boolean;
  readonly allowInvalidHostnames: boolean;
  readonly insecure: boolean;
}

// The strict default, and the value an older client or a scripted connect means
// by saying nothing.
// The credentials cannot reach into this database at all — not "no rows", not
// "no permission on a table", but no access to the database as a whole.
//
// A named failure rather than a raw driver error because it is the one
// per-database failure the passes above a collector must SURVIVE: an
// inaccessible database contributes nothing and the rest of the cluster is still
// worth walking. Every other failure keeps aborting the pass, which is what a
// failure nobody has reasoned about should do.
//
// Reached most often on SQL Server, where a scoped login has a user only in the
// databases it was provisioned for (#244, and mssql/provision.ts): a database
// created — or ticked — afterwards is listed by `sys.databases` to any login,
// because VIEW ANY DATABASE is granted to public, and then refuses every read
// with Msg 916 (verified on 2022: `SELECT … FROM [other].sys.tables` answers
// "The server principal … is not able to access the database … under the current
// security context").
//
// All three adapters raise it, from the signal their own engine answers with, so
// the passes above need no engine in them (#345):
//
//   MongoDB     code 13 / Unauthorized on a per-database read, once the string
//               holds the cluster `listDatabases` action without matching
//               per-database grants (measured on 7.0)
//   PostgreSQL  42501 (no CONNECT), 3D000 (gone), 28000/28P01 (auth) at the dial
//               `poolFor(database)` makes for that database (measured on 18.6)
//   SQL Server  Msg 916, as above
export class DatabaseInaccessibleError extends Error {
  constructor(
    readonly database: string,
    cause?: unknown,
  ) {
    super(`no access to database ${database} with these credentials`);
    this.name = "DatabaseInaccessibleError";
    this.cause = cause;
  }
}

export const NO_TLS_OVERRIDES: TlsOverrides = {
  allowInvalidCertificates: false,
  allowInvalidHostnames: false,
  insecure: false,
};

// One index's usage on one replica-set member ($indexStats is per-member; on a
// sharded cluster mongos merges every shard's members, tagged by host).
// Relational engines report one "member" per server.
export interface IndexUsageStat {
  readonly indexName: string;
  readonly host: string;
  readonly ops: number;
  readonly since: string;
}

export interface LatencyPair {
  readonly ops: number;
  readonly latencyMicros: number;
}

export interface CollectionLatency {
  readonly reads: LatencyPair;
  readonly writes: LatencyPair;
}

export interface CollectionStorage {
  readonly dataSizeBytes: number;
  readonly docCount: number;
}

// An age-based delete pattern: recurring `deleteMany({field: {$lt: date}})` on
// mongo, a recurring `DELETE … WHERE ts < …` in Query Store on SQL Server. The
// SIGNAL is the same on both — a job pruning by timestamp on a schedule — and
// the recommendation is not, because SQL Server has no TTL index; what the
// advisory says is jobs/suggest.ts's business.
export interface DeletePattern {
  readonly field: string;
  // Executions of the purge, which is what the recurrence gate reads.
  readonly count: number;
  // Null when the store shows the predicate but not the value it compared
  // against. Mongo's profiler always records the literal cutoff; a
  // parameterised `DELETE … WHERE created_at < @cutoff` in Query Store carries
  // `@cutoff`, and that is the most common dialect an ORM or a stored procedure
  // produces. The advisory is worth making without the number, so this is
  // absent rather than guessed.
  readonly medianRetentionSeconds: number | null;
}

// One namespace to gather query shapes for.
export interface WorkloadTarget {
  readonly database: string;
  readonly collection: string;
}

// Key for a collectWorkload result map. NUL-separated: a collection name may
// contain almost anything, including spaces and dots.
export function workloadKey(database: string, collection: string): string {
  return [database, collection].join("\u0000");
}

// Read-only statistics surface — everything the engine needs to decide, and
// deliberately nothing that can read customer data rows.
// One node of the cluster as the last collect saw it (#100). Engine-neutral:
// the roles are what any topology can honestly claim, and a single-server
// engine is a roster of one "standalone".
export interface ClusterNode {
  readonly host: string;
  readonly role: "primary" | "secondary" | "mongos" | "standalone" | "unknown";
  // answered — dialled and spoke; unreachable — the dial failed;
  // refused — this deployment's net guard would not dial the address the
  // cluster named (policy, not member health).
  readonly state: "answered" | "unreachable" | "refused";
}

export interface IndexCollector {
  listCollectionNames(database: string): Promise<string[]>;
  listIndexes(database: string, collection: string): Promise<IndexSpec[]>;
  collectUsage(database: string, collection: string): Promise<IndexUsageStat[]>;
  indexSizes(database: string, collection: string): Promise<Record<string, number>>;
  collectionStorage(database: string, collection: string): Promise<CollectionStorage>;
  readLatency(database: string, collection: string): Promise<LatencyPair>;
  collectionLatency(database: string, collection: string): Promise<CollectionLatency>;
  collectSlowQueries(database: string, collection: string): Promise<QueryShape[]>;
  // Batched deliberately. Every engine's workload source is one cluster-wide
  // store you filter per namespace — Mongo's `$queryStats`, Postgres's
  // `pg_stat_statements` — so a per-collection signature invites reading the
  // whole thing once per collection. Takes every namespace at once and returns
  // a map keyed by `workloadKey`; missing entries mean no shapes were found.
  collectWorkload(targets: readonly WorkloadTarget[]): Promise<Map<string, readonly QueryShape[]>>;
  collectDeletePatterns(database: string, collection: string): Promise<DeletePattern[]>;
  // Server-wide query-engine counters. Null when the credentials cannot read
  // them — the privilege is optional, and everything else still works.
  collectServerHealth(): Promise<ServerHealth | null>;
  // Every node this collect could see and how each answered (#100). Null when
  // even that could not be established; a relational engine reports the one
  // server it is. No extra privilege: built from the dials the collector
  // makes anyway, plus each node's own handshake.
  collectNodes(): Promise<readonly ClusterNode[] | null>;
  // Indexes named explicitly with hint(). Hiding one breaks its queries instead
  // of slowing them, so no latency gate can catch the mistake.
  collectHintedIndexes(database: string, collection: string): Promise<string[]>;
}

export interface CreateIndexOptions {
  readonly name?: string;
  readonly unique?: boolean;
  // Index only the documents that HAVE the field. Carried when a REORDER
  // rebuilds an index that had it, and when an undo restores one — a sparse
  // index that comes back dense indexes documents the original never did, and a
  // unique+sparse pair is the "unique among documents that have it" pattern,
  // which a dense rebuild would refuse to build at all.
  readonly sparse?: boolean;
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  readonly collation?: { readonly locale: string };
  // Non-key columns carried at the leaves (SQL Server INCLUDE). Restoring an
  // index without them gives back something that seeks the same and covers
  // less, which no latency gate on the WRITE side would ever notice. Engines
  // with no such concept must drop it rather than forward it — MongoDB's
  // createIndexes rejects an option it does not know.
  readonly include?: readonly string[];
}

// The only write surface. Implementations must enforce read-only mode
// structurally (throw on any write when the cluster is read-only).
export interface IndexExecutor {
  hide(database: string, collection: string, indexName: string): Promise<void>;
  unhide(database: string, collection: string, indexName: string): Promise<void>;
  drop(database: string, collection: string, indexName: string): Promise<void>;
  create(
    database: string,
    collection: string,
    keys: Record<string, 1 | -1>,
    options: CreateIndexOptions,
  ): Promise<IndexBuildOutcome>;
  // What became of a build that create() reported as SCHEDULED, and the cleanup
  // that goes with it (#332).
  //
  // Present exactly on an adapter whose create() can return SCHEDULED — so only
  // PostgreSQL, and jobs/building.ts treats its absence as "this engine builds
  // synchronously and there is nothing to settle". Called until it stops
  // answering PENDING.
  //
  // Removing the scheduled job is this method's business, not the caller's: the
  // mechanism that recurs is the adapter's own and nothing above the port knows
  // a job exists.
  settleBuild?(
    database: string,
    collection: string,
    indexName: string,
  ): Promise<IndexBuildSettlement>;
}

export type IndexBuildSettlement =
  | { state: "PENDING" }
  | { state: "READY" }
  | { state: "FAILED"; message: string };

// Whether the index EXISTS when create() returns, or has only been asked for.
//
// BUILT on every engine that builds synchronously, which is both other adapters
// and PostgreSQL whenever the connected role owns the table. SCHEDULED is the
// PostgreSQL pg_cron route (#332): the build runs in a background worker some
// time after this returns, so the caller must not record it as done — it lands
// in BUILDING and a later tick reads `indisvalid` to find out how it went.
//
// A return value rather than a capability flag, because it is a fact about THIS
// build rather than about the adapter: the same PostgreSQL cluster builds
// synchronously for a table its role owns and asynchronously for one it does not.
export type IndexBuildOutcome = "BUILT" | "SCHEDULED";

// One privilege the engine needs, and whether these credentials have it.
// CORE = analysis is impossible without it; APPLY = the cluster can still be
// analyzed but nothing can be changed; WORKLOAD = an optional signal source.
//
// PROVISION is not about the engine at all: it is whether these credentials
// could create the least-privilege user we would rather run as. Reported as
// checks and not only as `canProvision` below, because a bare `false` renders as
// nothing and leaves "your user cannot create users" and "we could not tell what
// your user can do" looking identical (#86).
//
// SURPLUS is the list read backwards (#313): a grant these credentials HOLD and
// the engine never uses. On one of those `granted: true` is the finding rather
// than the reassurance, and `command` is what REVOKES it rather than what adds
// it — which is why they travel in `ConnectionDiagnosis.surplus` and not in
// `privileges`, where every reader treats a tick as good news.
export type PrivilegeTier = "CORE" | "APPLY" | "WORKLOAD" | "PROVISION" | "SURPLUS";

export interface PrivilegeCheck {
  readonly key: string;
  readonly label: string;
  readonly enables: string;
  readonly tier: PrivilegeTier;
  readonly granted: boolean;
  // Statements that would close this gap, ready to run, or null (#246). See the
  // contract's own comment for why the field is engine-neutral and the content is
  // not.
  readonly command: string | null;
}

// What a connection string can actually do — computed before anything is
// stored, so onboarding can say exactly what is missing (or offer to create a
// scoped user when the credentials are privileged enough).
export interface ConnectionDiagnosis {
  readonly reachable: boolean;
  // Failure reason, or an advisory note on an otherwise usable connection.
  readonly message: string | null;
  readonly username: string | null;
  readonly authEnabled: boolean;
  // Every PROVISION check granted — so the offer to create a scoped user is
  // worth making. The checks themselves are in `privileges`; this is the summary
  // the form branches on.
  readonly canProvision: boolean;
  readonly ready: boolean;
  readonly canApply: boolean;
  readonly privileges: readonly PrivilegeCheck[];
  // What these credentials hold and the engine never uses, each with the
  // statement that removes it (#313). Every entry is tier SURPLUS.
  //
  // Empty is the reassuring answer and a real one — a provisioned user holds
  // nothing surplus by construction — so the screen that draws it says so rather
  // than drawing nothing (#289).
  //
  // Segregated from `privileges` above because three of the fields on this
  // interface are computed from "is every check in its tier granted": a held
  // surplus grant would satisfy `ready`, and revoking it would break it. The
  // polarity is genuinely opposite, so the arrays are too.
  readonly surplus: readonly PrivilegeCheck[];
  readonly missing: readonly string[];
  // Every user database the credentials can see — the whole cluster's, never
  // narrowed by the scope the diagnosis was asked about, because this is the list
  // the observe checkboxes are drawn from and a database that is not in it can
  // never be ticked (#244).
  readonly databases: readonly string[];
}

// Where engines genuinely differ — checked at the feature gates, not deep in
// the pipeline.
export interface EngineCapabilities {
  // Reversible index invisibility (mongo collMod hidden, MSSQL DISABLE+REBUILD).
  //
  // False makes the observe stage statistics-only: apply.ts moves the
  // recommendation into the window without touching the index, records no
  // read-latency baseline (hiding is the only thing such a baseline could
  // measure), and the evidence for the drop is the usage counters staying flat,
  // which preflightDrop re-checks at the end. Read through
  // `openClusterSession`'s `canHide` — no pipeline site reaches for the registry
  // itself — and mirrored for the dashboard's wording by `canHideIndexes` in
  // @repo/contracts, which registry.test.ts holds to this value.
  //
  // PostgreSQL is the engine that will set it false: its only mechanism is
  // clearing `pg_index.indisvalid`, which needs superuser and cannot be
  // delegated (measured on 17.11 and 18.6, #35).
  readonly hideIndexes: boolean;
  // Can create a scoped least-privilege user from an admin connection string.
  readonly provisionScopedUsers: boolean;
}

// One live, pooled connection to a customer cluster.
export interface EngineSession {
  readonly collector: IndexCollector;
  executor(readOnly: boolean): IndexExecutor;
  // User databases only. The rule, which "its own system namespaces" was too
  // vague to keep the three adapters honest about (#347):
  //
  //   BY NAME. Each adapter excludes the databases its ENGINE owns and uses —
  //   mongo's admin/local/config, SQL Server's master/tempdb/model/msdb — and
  //   nothing else. A reader can predict the list from the engine's own
  //   documentation, which is the property being bought.
  //
  // One exception, and it is not a system database: PostgreSQL's `postgres` is an
  // ordinary database initdb creates so a client has somewhere to connect, empty
  // on almost every install. It is reported only when it holds a user table.
  //
  // The count is load-bearing, which is why the difference was worth settling:
  // the observe checkboxes are drawn at MIN_DATABASES_TO_CHOOSE (2) and up, so an
  // adapter that reports one extra database offers a choice its peers do not, and
  // the default selection — null, meaning all of them — walks whatever is in the
  // list on every pass.
  listDatabaseNames(): Promise<string[]>;
  // Cheap liveness round-trip (rotation verifies new credentials with this).
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface EngineAdapter {
  readonly engine: ClusterEngine;
  readonly capabilities: EngineCapabilities;
  // What a valid string looks like, for the refusal isConnString produces —
  // the one user-facing sentence an engine owns about its own syntax.
  readonly connStringHint: string;
  // Shape-validates a connection string BEFORE any dial (scheme guard).
  isConnString(value: string): boolean;
  // Every host the string would dial, for the network guard to vet.
  hostsOf(value: string): { hosts: string[]; isSrv: boolean };
  // Throws when the string would not connect over TLS, or when it turns off a
  // certificate check the owner did not consent to. Engine-specific because how
  // transport is expressed is: mongo puts it in the scheme and the `tls`/`ssl`
  // params, postgres in `sslmode`. The adapter also OWNS the enforcement — this
  // exists so onboarding can refuse with the reason rather than discovering it
  // as a failed dial.
  assertSecureTransport(value: string, overrides?: TlsOverrides): void;
  // The owner's checkbox choices written into the string, so what is stored and
  // what was consented to cannot disagree.
  applySecureTransport(value: string, overrides: TlsOverrides): string;
  open(connectionString: string, overrides?: TlsOverrides): Promise<EngineSession>;
  // Report what these credentials may do, without writing anything.
  //
  // `observedDatabases` narrows what the answer is ABOUT (#244): both adapters
  // evaluate their per-database requirements over the databases in scope, so a
  // role covering only the databases somebody asked us to observe reports as
  // granted instead of as a gap. Undefined and null both mean the whole cluster,
  // which is what the first preflight always is. The diagnosis still reports every
  // database the cluster has, narrowed or not — that list is what the checkboxes
  // are drawn from.
  diagnose(
    connectionString: string,
    overrides?: TlsOverrides,
    observedDatabases?: readonly string[] | null,
  ): Promise<ConnectionDiagnosis>;
  // Use an admin string ONCE to create the least-privilege user this engine
  // would rather run as, and return that user's string. The admin string is
  // never stored, and a failed verification undoes what was created.
  //
  // Present exactly when `capabilities.provisionScopedUsers` is true — the flag
  // is what callers branch on, and this is what they then call. Throws
  // ProvisionDeniedError when the credentials cannot create the user.
  //
  // Takes no observe selection, on either engine and by decision (#244): the
  // selection is what Indexterity LOOKS AT, not what the provisioned user MAY look
  // at. A user granted only where the selection pointed could never be widened
  // afterwards — provisioning runs once, from an admin string that is never
  // stored — so ticking another database would be a dead end. Both adapters grant
  // across the databases that exist when they run, and the selection stays a row in
  // postgres that can change any time. See mssql/provision.ts for the footprint
  // that buys, and what it still withholds.
  provisionScopedUser?(
    adminConnectionString: string,
    overrides?: TlsOverrides,
  ): Promise<ProvisionedUser>;
  // The statement(s) that remove the scoped user, for the disconnect screen and
  // the already-provisioned refusal. Handed to the operator rather than run:
  // dropping a user needs the admin credentials this product deliberately does
  // not keep, so this is text, not an action.
  //
  // Engine-specific in a way a caller cannot fake (#338). MongoDB's user lives
  // in `admin` and one statement removes it; the other two grant per database,
  // and both refuse a bare drop while any of those grants remain — so they need
  // the database list and emit several statements. `databases` is what
  // provisioning actually created a user in, replayed from the row rather than
  // discovered now: a database created since then has no user of ours in it,
  // and one dropped since needs no statement.
  revokeStatements(username: string, databases: readonly string[]): string;
  // The username a string authenticates as, so rotation can tell whether the
  // stored "this is a provisioned user" marker still describes the new one.
  connStringUsername(value: string): string | null;
}

export interface ProvisionedUser {
  readonly connectionString: string;
  readonly username: string;
  // Where a user was actually created. Empty for an engine whose scoped user is
  // server-scoped, which is MongoDB's single user in `admin`. Stored on the row
  // because provisioning runs once from an admin string that is never kept, so
  // this is the only chance to record what has to be undone.
  readonly databases: readonly string[];
}

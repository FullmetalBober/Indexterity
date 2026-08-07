import type { IndexSpec, QueryShape, ServerHealth } from "../analysis";

// The engine-neutral boundary. Everything above this file — the analysis core,
// the job pipeline, the API — speaks these ports; everything below implements
// them per database engine. Today MongoDB is the only adapter; the PostgreSQL
// and SQL Server mappings are documented on the wiki's Architecture page under
// Engine ports (pg_stat_user_indexes / sys.dm_db_index_usage_stats etc.).
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

// An age-based delete pattern: recurring deleteMany({field: {$lt: date}}) — the
// TTL-advisory signal (mongo-specific today; relational analogue: DELETE with
// a timestamp predicate in the statement store).
export interface DeletePattern {
  readonly field: string;
  readonly count: number;
  readonly medianRetentionSeconds: number;
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
  readonly partialFilterExpression?: Readonly<Record<string, string | number | boolean>>;
  readonly collation?: { readonly locale: string };
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
  ): Promise<void>;
}

// One privilege the engine needs, and whether these credentials have it.
// CORE = analysis is impossible without it; APPLY = the cluster can still be
// analyzed but nothing can be changed; WORKLOAD = an optional signal source.
//
// PROVISION is not about the engine at all: it is whether these credentials
// could create the least-privilege user we would rather run as. Reported as
// checks and not only as `canProvision` below, because a bare `false` renders as
// nothing and leaves "your user cannot create users" and "we could not tell what
// your user can do" looking identical (#86).
export type PrivilegeTier = "CORE" | "APPLY" | "WORKLOAD" | "PROVISION";

export interface PrivilegeCheck {
  readonly key: string;
  readonly label: string;
  readonly enables: string;
  readonly tier: PrivilegeTier;
  readonly granted: boolean;
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
  readonly missing: readonly string[];
}

// Where engines genuinely differ — checked at the feature gates, not deep in
// the pipeline.
export interface EngineCapabilities {
  // Reversible index invisibility (mongo collMod hidden, MSSQL DISABLE+REBUILD).
  // PostgreSQL has no native equivalent: its adapter will need an alternative
  // observe stage before the pipeline may drop.
  readonly hideIndexes: boolean;
  // Can create a scoped least-privilege user from an admin connection string.
  readonly provisionScopedUsers: boolean;
}

// One live, pooled connection to a customer cluster.
export interface EngineSession {
  readonly collector: IndexCollector;
  executor(readOnly: boolean): IndexExecutor;
  // User databases only — each adapter excludes its own system namespaces.
  listDatabaseNames(): Promise<string[]>;
  // Cheap liveness round-trip (rotation verifies new credentials with this).
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface EngineAdapter {
  readonly engine: ClusterEngine;
  readonly capabilities: EngineCapabilities;
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
  diagnose(connectionString: string, overrides?: TlsOverrides): Promise<ConnectionDiagnosis>;
}

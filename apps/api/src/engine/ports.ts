import type { IndexSpec, QueryShape } from "../analysis";

// The engine-neutral boundary. Everything above this file — the analysis core,
// the job pipeline, the API — speaks these ports; everything below implements
// them per database engine. Today MongoDB is the only adapter; the PostgreSQL
// and SQL Server mappings are documented in docs/architecture.md §"Engine
// ports" (pg_stat_user_indexes / sys.dm_db_index_usage_stats etc.).
//
// Vocabulary is MongoDB-flavored on purpose ("collection", "database") — a
// relational adapter maps them (table, schema/database) rather than the whole
// codebase adopting a lowest-common-denominator vocabulary.

export type ClusterEngine = "MONGODB" | "POSTGRESQL" | "MSSQL";

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
export type PrivilegeTier = "CORE" | "APPLY" | "WORKLOAD";

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
  open(connectionString: string): Promise<EngineSession>;
  // Report what these credentials may do, without writing anything.
  diagnose(connectionString: string): Promise<ConnectionDiagnosis>;
}

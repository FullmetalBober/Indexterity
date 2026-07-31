import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Sealed secrets (see crypto.ts) stored as raw bytes.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// --- enums ---------------------------------------------------------------
export const connectionMode = pgEnum("connection_mode", ["HOSTED_DIRECT", "AGENT"]);
// Must match ClusterEngine in src/engine/ports.ts (the adapter registry keys).
export const clusterEngine = pgEnum("cluster_engine", ["MONGODB", "POSTGRESQL", "MSSQL"]);
export const recommendationType = pgEnum("recommendation_type", [
  "DROP_UNUSED",
  "DROP_REDUNDANT",
  "MERGE",
  "CREATE",
  "UPDATE",
  "ADVISORY_REVIEW",
]);
export const recommendationState = pgEnum("recommendation_state", [
  "PROPOSED",
  "APPROVED",
  "HIDDEN",
  "OBSERVE",
  "DROPPED",
  "SCHEDULED",
  "BUILDING",
  "ACTIVE",
  "ROLLED_BACK",
  "REJECTED",
]);
export const usageClass = pgEnum("usage_class", [
  "CONTINUOUS",
  "PERIODIC_ALIVE",
  "PERIODIC_DEAD",
  "FLAT_ZERO",
]);

// --- better-auth tables (regenerate with the better-auth CLI to guarantee an
// exact column match before wiring auth) ---------------------------------
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt,
  updatedAt,
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt,
  updatedAt,
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt,
  updatedAt,
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
});

// --- tenancy -------------------------------------------------------------
export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt,
});

export const members = pgTable("members", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  // The org switcher's selection. At most one true per user; when none is set
  // the oldest membership is the active one (the pre-switcher behavior).
  isActive: boolean("is_active").notNull().default(false),
  createdAt,
});

// Pending invitations into an org. The token is the bearer credential (returned
// once at creation); accepting adds the caller as a member and stamps acceptedAt.
export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  token: text("token").notNull().unique(),
  invitedBy: text("invited_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt,
});

// --- managed clusters ----------------------------------------------------
export const clusters = pgTable("clusters", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  connectionMode: connectionMode("connection_mode").notNull().default("HOSTED_DIRECT"),
  // Which adapter dials this cluster (src/engine/registry.ts). Only MONGODB is
  // implemented today; the column makes the data model engine-ready.
  engine: clusterEngine("engine").notNull().default("MONGODB"),
  readOnly: boolean("read_only").notNull().default(true),
  // The control plane holds the cluster's connection string, envelope-encrypted.
  // keyVersion selects the master key that sealed it (MASTER_KEY, MASTER_KEY_V2,
  // …) so the KEK can rotate without re-sealing everything at once.
  sealedDek: bytea("sealed_dek").notNull(),
  sealedData: bytea("sealed_data").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  // The least-privilege user Indexterity created on the cluster during
  // admin-string onboarding; null when the customer pasted a ready-made string.
  provisionedUsername: text("provisioned_username"),
  createdAt,
});

export const indexSnapshots = pgTable(
  "index_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    database: text("database").notNull(),
    collection: text("collection").notNull(),
    indexName: text("index_name").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    perMember: jsonb("per_member").$type<Array<{ member: string; ops: number }>>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("index_snapshots_cluster_time").on(table.clusterId, table.capturedAt)],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    type: recommendationType("type").notNull(),
    usageClass: usageClass("usage_class"),
    state: recommendationState("state").notNull().default("PROPOSED"),
    database: text("database").notNull(),
    collection: text("collection").notNull(),
    indexName: text("index_name").notNull(),
    rationale: text("rationale").notNull(),
    // Confidence 0-100 — gates propose/auto-approve, never the safety stages.
    score: integer("score").notNull().default(0),
    estimatedBytesSaved: bigint("estimated_bytes_saved", { mode: "number" }).notNull().default(0),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    // The observe window this drop actually got, decided at hide time from the
    // index's own usage history (analysis/observe.ts). Null = policy baseline.
    observeDays: integer("observe_days"),
    baselineReadOps: bigint("baseline_read_ops", { mode: "number" }),
    baselineReadLatency: bigint("baseline_read_latency", { mode: "number" }),
    // Set when a CREATE/UPDATE/MERGE is built: the write-latency baseline for the
    // post-build regression watch. Cleared once the index graduates the window.
    builtAt: timestamp("built_at", { withTimezone: true }),
    baselineWriteOps: bigint("baseline_write_ops", { mode: "number" }),
    baselineWriteLatency: bigint("baseline_write_latency", { mode: "number" }),
    targetSpec: jsonb("target_spec").$type<{
      keys: string[];
      retire: string[];
      partial?: Record<string, string | number | boolean>;
    }>(),
    createdAt,
    updatedAt,
  },
  (table) => [index("recommendations_cluster_state").on(table.clusterId, table.state)],
);

// Immutable audit of every executed operation and its rollback token.
export const actions = pgTable(
  "actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actor: text("actor").notNull(),
    result: text("result").notNull(),
    rollbackToken: jsonb("rollback_token").$type<Record<string, unknown>>(),
    createdAt,
  },
  (table) => [index("actions_recommendation").on(table.recommendationId)],
);

export const roiMetrics = pgTable("roi_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  clusterId: uuid("cluster_id")
    .notNull()
    .references(() => clusters.id, { onDelete: "cascade" }),
  // Which recommendation earned (or, negative on undo, un-earned) this row —
  // the dashboard's per-index attribution. Null on legacy aggregate rows.
  recommendationId: uuid("recommendation_id").references(() => recommendations.id, {
    onDelete: "cascade",
  }),
  freedBytes: bigint("freed_bytes", { mode: "number" }).notNull().default(0),
  indexCountDelta: integer("index_count_delta").notNull().default(0),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
});

export const policies = pgTable("policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  clusterId: uuid("cluster_id")
    .notNull()
    .unique()
    .references(() => clusters.id, { onDelete: "cascade" }),
  autoApply: boolean("auto_apply").notNull().default(false),
  workloadAnalysis: boolean("workload_analysis").notNull().default(false),
  // Auto-approve + build brand-new indexes on critical (large) collections.
  instantCreate: boolean("instant_create").notNull().default(false),
  observeWindowDays: integer("observe_window_days").notNull().default(30),
  maxCollectionSizeBytes: bigint("max_collection_size_bytes", { mode: "number" }),
  // Recommendations scoring >= this auto-approve (null = only manual/autoApply).
  autoApplyScore: integer("auto_apply_score"),
  // Elective changes (hide/build/drop) only run inside this UTC hour window;
  // safety actions (unhide, regression rollback) ignore it. Null = anytime.
  changeWindowStartHour: integer("change_window_start_hour"),
  changeWindowEndHour: integer("change_window_end_hour"),
});

// Regression memory: an index whose drop slowed reads during observe is parked
// here so the engine won't re-propose it until `until`. Repeats escalate.
export const indexCooldowns = pgTable(
  "index_cooldowns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    database: text("database").notNull(),
    collection: text("collection").notNull(),
    indexName: text("index_name").notNull(),
    reason: text("reason").notNull(),
    regressionCount: integer("regression_count").notNull().default(1),
    until: timestamp("until", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("index_cooldowns_target").on(
      table.clusterId,
      table.database,
      table.collection,
      table.indexName,
    ),
  ],
);

// Per-collection read/write latency sampled each collect — a time series that
// shows the app getting faster (or a build/drop regressing it).
export const latencySamples = pgTable(
  "latency_samples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    database: text("database").notNull(),
    collection: text("collection").notNull(),
    readOps: bigint("read_ops", { mode: "number" }).notNull(),
    readLatencyMicros: bigint("read_latency_micros", { mode: "number" }).notNull(),
    writeOps: bigint("write_ops", { mode: "number" }).notNull(),
    writeLatencyMicros: bigint("write_latency_micros", { mode: "number" }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("latency_samples_cluster_time").on(table.clusterId, table.capturedAt)],
);

import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
export const recommendationType = pgEnum("recommendation_type", [
  "DROP_UNUSED",
  "DROP_REDUNDANT",
  "MERGE",
  "CREATE",
  "UPDATE",
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
  demoMode: boolean("demo_mode").notNull().default(true),
  // The control plane holds the cluster's connection string, envelope-encrypted.
  sealedDek: bytea("sealed_dek").notNull(),
  sealedData: bytea("sealed_data").notNull(),
  createdAt,
});

export const indexSnapshots = pgTable("index_snapshots", {
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
});

export const recommendations = pgTable("recommendations", {
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
  estimatedBytesSaved: bigint("estimated_bytes_saved", { mode: "number" }).notNull().default(0),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  baselineReadOps: bigint("baseline_read_ops", { mode: "number" }),
  baselineReadLatency: bigint("baseline_read_latency", { mode: "number" }),
  targetSpec: jsonb("target_spec").$type<{ keys: string[]; retire: string[] }>(),
  createdAt,
  updatedAt,
});

// Immutable audit of every executed operation and its rollback token.
export const actions = pgTable("actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  recommendationId: uuid("recommendation_id")
    .notNull()
    .references(() => recommendations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  actor: text("actor").notNull(),
  result: text("result").notNull(),
  rollbackToken: jsonb("rollback_token").$type<Record<string, unknown>>(),
  createdAt,
});

export const roiMetrics = pgTable("roi_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  clusterId: uuid("cluster_id")
    .notNull()
    .references(() => clusters.id, { onDelete: "cascade" }),
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
  observeWindowDays: integer("observe_window_days").notNull().default(30),
  maxCollectionSizeBytes: bigint("max_collection_size_bytes", { mode: "number" }),
});

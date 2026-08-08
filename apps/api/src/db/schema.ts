import { sql } from "drizzle-orm";
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Sealed secrets (see crypto.ts) stored as raw bytes.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// The closed interval a run-length row covers, derived from its two endpoints so
// it cannot disagree with them. Exists only to be the range side of an exclusion
// constraint — nothing selects it, and readers keep using captured_at/last_seen_at.
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tstzrange";
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
// Which producer authored a recommendation. Three jobs write to one table and
// each rewrites its PROPOSED rows from scratch on every pass, so each has to
// know which rows are its own to clear.
//
//   CLASSIFY - the usage/redundancy engine (classify.ts)
//   WORKLOAD - the query-shape engine (suggest.ts)
//   RETIRE   - a one-shot drop for an index a graduated build replaced
//              (finalize.ts). Derived from a build that already happened, so
//              nothing re-derives it: if a sweep deletes it, it is gone.
export const recommendationSource = pgEnum("recommendation_source", [
  "CLASSIFY",
  "WORKLOAD",
  "RETIRE",
]);

// --- better-auth tables (regenerate with the better-auth CLI to guarantee an
// exact column match before wiring auth) ---------------------------------
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // The twoFactor plugin's flag, and the only 2FA fact most requests need:
  // true only after the first TOTP code verifies, not on enrolment (#55).
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt,
  updatedAt,
});

// better-auth's twoFactor plugin, one row per enrolled user: the TOTP secret
// and the backup codes, both encrypted with BETTER_AUTH_SECRET before they get
// here (`returned: false` in the plugin's schema — they never leave the api).
// The lockout columns are the plugin's own brute-force brake on top of the
// rate limit it registers for /two-factor/*.
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [
    index("two_factor_user").on(table.userId),
    index("two_factor_secret").on(table.secret),
  ],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Which org this session is looking at — the organization plugin's own
    // switcher state, and per SESSION rather than per user, so two browsers can
    // sit in two different orgs. It replaced a `members.is_active` flag, which
    // could not.
    //
    // SET NULL rather than cascade: deleting an org must not sign its members
    // out of the app, only out of that org. A null here falls back to the
    // caller's oldest membership (auth/tenancy.ts).
    activeOrganizationId: uuid("active_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    createdAt,
    updatedAt,
  },
  // Deleting a user cascades here, and deleting an org nulls the active pointer
  // — both would otherwise scan every session row, and this is the table that
  // grows with every sign-in.
  (table) => [
    index("session_user").on(table.userId),
    index("session_active_org").on(table.activeOrganizationId),
  ],
);

export const account = pgTable(
  "account",
  {
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
  },
  // Cascades on user deletion.
  (table) => [index("account_user").on(table.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
});

// better-auth's rate-limit counters, one row per (client address, auth path).
//
// It kept these in this process's memory, which made the limit per pod: the
// ceiling was really max × replicas, which pod a request landed on decided which
// bucket it spent, and a rollout handed every attacker their budget back (#54).
// `rateLimit.storage: "database"` (auth/rate-limit.ts) puts them here instead, so
// every replica counts against one total.
//
// The shape is better-auth's, not ours — the property names are what its adapter
// looks up, so `lastRequest` cannot be renamed even though the column can.
// `lastRequest` is epoch milliseconds and declared bigint by better-auth, which
// is right: it compares it to Date.now(), and 2^31 ms ran out in 1994.
//
// No retention job: better-auth deletes rows past the widest window on every
// write, so the table stays the size of whatever is currently being limited.
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// --- tenancy -------------------------------------------------------------
//
// Owned by better-auth's organization plugin (auth/auth.config.ts maps its
// `organization`/`member`/`invitation` models onto these three tables and their
// existing column names). Ids stay `uuid` — the plugin is handed a
// `crypto.randomUUID()` generator instead of its own — because three tables
// carry a cascading `org_id` and the contracts type it `z.uuid()`; retyping that
// key is the migration the billing comment below warns about.
//
// The plan columns are declared to the plugin as `additionalFields` with
// `input: false`, so they are readable through it and settable by nobody but us.
export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  // Required and unique by the plugin, which resolves orgs by slug as well as
  // by id. Derived from the name at creation, deduplicated with a suffix.
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  // better-auth serialises organization metadata to a JSON *string*, not jsonb.
  // Nothing of ours reads it — the plan lives in real columns below, because it
  // is read on nearly every request and wants an index-able one.
  metadata: text("metadata"),
  // What this org is entitled to — the rules live in billing/plans.ts, this is
  // only which set applies. Text rather than an enum so adding a plan is a
  // constant, not a migration; unrecognised values fall back to FREE.
  plan: text("plan").notNull().default("FREE"),
  planUpdatedAt: timestamp("plan_updated_at", { withTimezone: true }),
  // Why it is on that plan: an invoice number, a trial end, "founding
  // customer". Written by whoever changed it, shown to nobody but operators.
  planNote: text("plan_note"),
  // Set once a payment provider is attached. Nothing reads them yet — they are
  // here so wiring a provider is a webhook handler rather than a migration on a
  // table that by then holds live customers. Null means the plan was set by
  // hand, which is the only way it can be set today.
  billingProvider: text("billing_provider"),
  billingCustomerId: text("billing_customer_id"),
  billingSubscriptionId: text("billing_subscription_id"),
  createdAt,
});

export const members = pgTable(
  "members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt,
  },
  // The tenancy check, which runs on every authenticated request. Queried three
  // ways — by user, by org, and by both — so the composite leads with user and
  // the org gets its own: the same equality-ordering rule the engine applies to
  // everyone else's indexes. Both also back a cascading foreign key.
  (table) => [
    index("members_user_org").on(table.userId, table.orgId),
    index("members_org").on(table.orgId),
  ],
);

// Pending invitations into an org, the plugin's `invitation` model.
//
// The credential changed with it: this used to hold a bearer token returned once
// from createInvite and pasted back by whoever received the email, which meant
// anyone holding the string could join. The invitation id is not a secret now —
// accepting requires being signed in as the invited address.
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // pending | accepted | rejected | canceled. The plugin's lifecycle, and the
    // reason `accepted_at` went away: three of those four states are not a date.
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  // Listing an org's invites, two cascading foreign keys, and — since the
  // credential became the address rather than a token — listing the invitations
  // sent to one person, which every signed-in reader now asks on page load.
  (table) => [
    index("invites_org").on(table.orgId),
    index("invites_invited_by").on(table.invitedBy),
    index("invites_email").on(table.email),
  ],
);

// --- managed clusters ----------------------------------------------------
export const clusters = pgTable(
  "clusters",
  {
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
    // Which TLS checks the owner turned off when connecting, as checkboxes on the
    // connect form. Held HERE and not inferred from the sealed string, for two
    // reasons: every dial is then verified against a recorded decision rather
    // than against whatever the string happens to say, and the dashboard can
    // show a concession that would otherwise be invisible once made.
    //
    // jsonb with a default, so the column is additive and every existing row
    // reads as "nothing turned off" — which is what they all are, since until
    // now the options were refused outright.
    tlsOverrides: jsonb("tls_overrides")
      .$type<{
        allowInvalidCertificates: boolean;
        allowInvalidHostnames: boolean;
        insecure: boolean;
      }>()
      .notNull()
      .default({ allowInvalidCertificates: false, allowInvalidHostnames: false, insecure: false }),
    createdAt,
  },
  // Every cluster list is scoped to an org, and deleting an org cascades here.
  //
  // The name is unique WITHIN the org, and only exactly (#96). Two clusters
  // called "staging" are indistinguishable in the nav rail and, worse, in an
  // alert subject line — `[Indexterity] staging: regression on …` names neither
  // of them. Per org rather than globally, because one customer calling theirs
  // "production" must not stop another from doing the same.
  //
  // Case is not folded. "Staging" and "staging" are allowed to coexist, and are
  // told apart everywhere the name is drawn; a lower(name) index would refuse a
  // rename for looking like one that already exists, which is a rule nobody
  // asked for.
  (table) => [
    index("clusters_org").on(table.orgId),
    unique("clusters_org_name").on(table.orgId, table.name),
  ],
);

// One index, and the shape it had. The dimension half of the snapshot series:
// everything about an index that does NOT change between collects lives here
// once, and the time series carries only the measurement.
//
// `spec` was 66% of an index_snapshots row and 2.4x the size of the counter it
// accompanied, rewritten on every collect for the life of the cluster — 1,460
// copies a year per index at the 6h cadence, of a value that changes only when
// somebody rebuilds the index. So does the identity: a (database, collection,
// index_name) triple is a constant of the index, not an observation of it.
//
// Keyed by spec DIGEST, not by identity alone, so a rebuild adds a row rather
// than overwriting one. Overwriting would be cheaper and would break nothing
// today — every reader only wants the newest spec — but it would silently
// re-label the history: a snapshot from before the rebuild would come back
// joined to the shape the index has now. A dimension row that can lie about the
// past is worse than the bytes it saves, and rebuilds are rare enough that the
// extra rows do not register (7 of 211 on the dev database).
export const clusterIndexes = pgTable(
  "cluster_indexes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    database: text("database").notNull(),
    collection: text("collection").notNull(),
    indexName: text("index_name").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    // The upsert's conflict target, because the spec itself makes a poor index
    // key: jsonb compares fine but a fat partialFilterExpression can push a
    // btree tuple past its size limit, and the failure would land on a collect.
    //
    // Generated rather than computed by the writer, which is what makes it
    // trustworthy. Postgres stores jsonb with its keys sorted, so `spec::text`
    // is already canonical and two equal specs hash equal however mongo happened
    // to order the fields. A digest the application computed instead would have
    // to reproduce that canonical form exactly — every whitespace and number
    // formatting rule — and the day it drifted the writer would quietly start
    // inserting a second dimension row for an index that never changed.
    //
    // sha256, not md5, and not for secrecy — nobody is attacking this. A collision
    // here silently MERGES two different index shapes into one dimension row, so
    // every snapshot of one would be reported under the other's spec and the
    // redundancy engine would reason about an index that does not exist. Odds are
    // negligible either way; the difference is that md5's failure is reachable by
    // construction and silent when it lands, which is the wrong trade against 32
    // extra bytes on a table holding a few hundred rows.
    specDigest: text("spec_digest")
      .notNull()
      .generatedAlwaysAs(sql`encode(sha256(spec::text::bytea), 'hex')`),
    createdAt,
  },
  (table) => [
    uniqueIndex("cluster_indexes_identity").on(
      table.clusterId,
      table.database,
      table.collection,
      table.indexName,
      table.specDigest,
    ),
    // Every read of the series joins through here, always scoped to a cluster,
    // and offboarding cascades.
    index("cluster_indexes_cluster").on(table.clusterId),
  ],
);

// One row per distinct COUNTER STATE, not one per collect.
//
// An idle index reports byte-identical counters collect after collect, so the
// old shape spent a row on every look to record that nothing had happened.
// Instead a row covers the closed interval [capturedAt, lastSeenAt]: the state
// was first seen at the former and still true at the latter, confirmed
// `observations` times in between. Storage is then a function of how much the
// cluster CHANGES rather than of how often we look, which is what makes
// collecting more often affordable.
//
// Skipping the write entirely would have been simpler and wrong. The usage
// trust gate reads a hole in the series as "we stopped watching, so absence of
// usage proves nothing" — an idle index with no rows would be
// indistinguishable from a cluster we lost, and "cannot tell" would get spelled
// "all clear". `lastSeenAt` is the positive form of the same statement: we
// looked at T, and it was still this.
//
// The invariant that keeps the gap detection honest: a run never spans a hole
// longer than the classifier's own tolerance (see MAX_GAP_HOURS). An
// observation further from `lastSeenAt` than that starts a new row even when
// the counters match, so a hole the classifier would refuse to reason across
// can never be papered over by extending a run.
export const indexSnapshots = pgTable(
  "index_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Denormalised from cluster_indexes on purpose: it is the equality filter
    // of every query against this table and the key retention prunes by, and a
    // join to find it would make both of those a great deal more expensive.
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    indexId: uuid("index_id")
      .notNull()
      .references(() => clusterIndexes.id, { onDelete: "cascade" }),
    // As of `lastSeenAt`, not `capturedAt`. Size is not part of what makes a run
    // — an unused index on a write-heavy collection grows on every insert, and
    // keying runs on size would collapse nothing in exactly the case worth
    // collapsing — so it rides along at its newest value. Nothing reads the size
    // series; every caller wants the current number.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // `since` is the member's $indexStats counter start — the restart marker.
    // jsonb, so adding it needed no DDL; older rows simply omit the key.
    //
    // This is the run's identity: two collects belong to the same row when this
    // value is byte-identical.
    perMember: jsonb("per_member")
      .$type<Array<{ member: string; ops: number; since?: string }>>()
      .notNull(),
    // Seen as the target of a hint() in the profiler window. A hinted index
    // cannot be hidden — mongod rejects the hint — so the observe stage would
    // break those queries instead of slowing them, and the latency gate would
    // see nothing.
    //
    // Sticky within a run: one sighting anywhere in the retained history
    // protects the index, so extending a run ORs the new reading in rather than
    // replacing it. A sighting must not be erasable by the next quiet collect.
    hinted: boolean("hinted").notNull().default(false),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    // When this state was last confirmed still true. Equal to capturedAt for a
    // run of one.
    //
    // Deliberately WITHOUT a default. defaultNow() reads as the obvious choice
    // and is a trap: a caller that sets only capturedAt then writes a row
    // claiming a months-old reading was confirmed this instant, which is the one
    // field the usage trust gate consults to decide whether we were watching. No
    // default makes every insert say what it means, and the compiler finds the
    // ones that do not.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    // How many collects saw this exact counter state. The row count stopped
    // being the sample count the moment runs existed, and several thresholds
    // are counts of samples (minHistory, the score's history credit) — they read
    // this instead.
    observations: integer("observations").notNull().default(1),
    // The largest interval between two consecutive observations INSIDE this run,
    // in ms. Zero for a run of one, which has no interior.
    //
    // Exists so the trust gate can VERIFY there was no hole rather than trust that
    // there wasn't. A run asserts the counter held throughout its span, and the
    // readers only inspect the holes BETWEEN runs — which is sound exactly as long
    // as the collector refuses to extend across a gap the gate would object to.
    // That made a safety property depend on a constant shared between two modules
    // agreeing forever, with nothing in the data to check it against. One number,
    // maintained on extend as greatest(previous, now - last_seen_at), turns it into
    // something the reader can test for itself.
    //
    // bigint rather than integer on purpose: int4 tops out at about 24 days of ms,
    // and the whole point here is to stop relying on the writer's ceiling holding —
    // a check that silently overflows when the thing it guards against happens is
    // not a check.
    maxGapMs: bigint("max_gap_ms", { mode: "number" }).notNull().default(0),
    // The interval the two columns above describe, as a range, so the database can
    // enforce the thing they imply: two runs for one index must never overlap.
    //
    // Generated, so it cannot drift from its endpoints, and paired with an
    // EXCLUDE ... USING gist constraint added in the migration (drizzle has no
    // builder for exclusion constraints). Inclusive bounds on purpose — with '[)'
    // a run of one would be an EMPTY range, and an empty range overlaps nothing, so
    // the majority of rows on a busy cluster would go unprotected.
    //
    // Overlap is not hypothetical. Two collects racing, or a clock stepping
    // backwards, can produce a row whose capturedAt precedes the previous run's
    // end, and the readers difference `previous.lastSeenAt → next.capturedAt` to
    // find the holes — an overlap there is a NEGATIVE gap, which reads as no gap
    // at all. Better a loud insert failure than a series that quietly certifies a
    // window nobody watched.
    span: tstzrange("span")
      .notNull()
      .generatedAlwaysAs(sql`tstzrange(captured_at, last_seen_at, '[]')`),
  },
  (table) => [
    // Retention prunes by when a run ENDED: a run that started before the cutoff
    // and is still being extended is the current state of a live index, and
    // deleting it would erase the only evidence that we are watching.
    index("index_snapshots_cluster_time").on(table.clusterId, table.lastSeenAt),
    // The writer's newest-run-per-index lookup, and the per-index history read
    // behind the observe window.
    index("index_snapshots_index_time").on(table.indexId, table.capturedAt.desc()),
  ],
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
    source: recommendationSource("source").notNull().default("CLASSIFY"),
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
    // A CRITICAL missing index (analysis/severity.ts): the scan is costing on
    // every execution, so the build skips the change window rather than waiting
    // most of a day for the quiet slot.
    urgent: boolean("urgent").notNull().default(false),
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

export const roiMetrics = pgTable(
  "roi_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    // Which recommendation earned (or, negative on undo, un-earned) this row —
    // the dashboard's per-index attribution. Null on legacy aggregate rows.
    //
    // SET NULL, not cascade: retention prunes finished recommendations once they
    // pass the plan's history window, and the money this product saved must not
    // leave with them. The headline sums every row and has always tolerated a
    // null here; only the per-index attribution list needs the link, and that is
    // a recent-activity view by nature.
    recommendationId: uuid("recommendation_id").references(() => recommendations.id, {
      onDelete: "set null",
    }),
    freedBytes: bigint("freed_bytes", { mode: "number" }).notNull().default(0),
    indexCountDelta: integer("index_count_delta").notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  },
  // The recommendation index is the expensive omission. Retention deletes
  // settled recommendations in bulk, and every one of them made postgres scan
  // this whole table to satisfy the SET NULL — 8.4 seconds to remove ten
  // thousand rows, of which five milliseconds was finding them.
  //
  // The cluster index serves the ROI headline, which sums every row for a
  // cluster, and the cascade when a cluster is offboarded.
  (table) => [
    index("roi_metrics_recommendation").on(table.recommendationId),
    index("roi_metrics_cluster").on(table.clusterId),
  ],
);

export const policies = pgTable("policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  clusterId: uuid("cluster_id")
    .notNull()
    .unique()
    .references(() => clusters.id, { onDelete: "cascade" }),
  workloadAnalysis: boolean("workload_analysis").notNull().default(false),
  // Auto-approve + build brand-new indexes on critical (large) collections.
  instantCreate: boolean("instant_create").notNull().default(false),
  observeWindowDays: integer("observe_window_days").notNull().default(30),
  maxCollectionSizeBytes: bigint("max_collection_size_bytes", { mode: "number" }),
  // The single auto-approval control: null = nothing auto-approves (a human
  // clicks), 0 = everything does, anything between is a confidence floor.
  // ADVISORY_REVIEW is excluded at every setting.
  autoApplyScore: integer("auto_apply_score"),
  // Elective changes (hide/build/drop) only run inside this UTC hour window;
  // safety actions (unhide, regression rollback) ignore it. Null = the engine
  // picks one from observed traffic (below); it never means "anytime" now.
  changeWindowStartHour: integer("change_window_start_hour"),
  changeWindowEndHour: integer("change_window_end_hour"),
  // The window the engine derived from this cluster's own traffic, refreshed
  // after every collect. Kept apart from the columns above so an owner's choice
  // stays distinguishable from ours — and so clearing theirs returns to auto.
  inferredWindowStartHour: integer("inferred_window_start_hour"),
  inferredWindowEndHour: integer("inferred_window_end_hour"),
  inferredWindowReason: text("inferred_window_reason"),
});

// Outbound-dial budget per user. In Postgres rather than in memory because the
// thing it limits — how fast one account can sweep hosts the control plane will
// connect to — must not reset on deploy or multiply by the api replica count.
export const dialBudgets = pgTable("dial_budgets", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
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
//
// Run-length like index_snapshots, and for the same reason: an idle collection
// reports the same four cumulative counters every time. There is no dimension
// half to split out here, because every column IS a measurement — the namespace
// stays on the row.
// The node roster (#100): every member the LAST collect saw and how each
// answered, one row per cluster, replaced whole on every collect. Deliberately
// not a history table — "which nodes, right now, and did we reach them" is the
// question the panel answers, and a per-collect log of it would grow with the
// cadence like latency_samples does (D39) for a fact nobody asks about the
// past of. jsonb because the members ARE one fact: a roster read half-replaced
// would be a topology that never existed.
export const clusterRosters = pgTable("cluster_rosters", {
  clusterId: uuid("cluster_id")
    .primaryKey()
    .references(() => clusters.id, { onDelete: "cascade" }),
  // ClusterNode[] from engine/ports.ts: { host, role, state }.
  nodes: jsonb("nodes").$type<{ host: string; role: string; state: string }[]>().notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
});

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
    // See index_snapshots, including why this has no default.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    observations: integer("observations").notNull().default(1),
    // See index_snapshots.
    maxGapMs: bigint("max_gap_ms", { mode: "number" }).notNull().default(0),
    // Same guard, keyed by namespace instead of index_id. See index_snapshots.
    span: tstzrange("span")
      .notNull()
      .generatedAlwaysAs(sql`tstzrange(captured_at, last_seen_at, '[]')`),
  },
  (table) => [
    // By run end, for the same reason as index_snapshots.
    index("latency_samples_cluster_time").on(table.clusterId, table.lastSeenAt),
    // The five-minute probe wants the newest sample per namespace, which is a
    // `distinct on (database, collection) order by … captured_at desc`. Without
    // this the planner sorts every row the cluster has ever written, on every
    // probe. Leading with cluster_id because that is always the equality filter.
    //
    // Still captured_at, not last_seen_at: runs for one namespace are appended
    // in time order and never overlap, so the newest run START is the newest run,
    // and its counters are the current ones however long it has been extended.
    index("latency_samples_cluster_ns_time").on(
      table.clusterId,
      table.database,
      table.collection,
      table.capturedAt.desc(),
    ),
  ],
);

// --- the security trail --------------------------------------------------
//
// `actions` is the other half of this: an immutable record of every index
// operation, per cluster. It answers "what removed this index, and who approved
// it" — and stops there. How that person came to be an owner, whether their
// session was still theirs at the time, who else was in the org that week: none
// of it left a row anywhere (#53). `session` and `account` are current state, not
// events; a revoked session is a deleted row.
//
// So this table records the OWNER-LEVEL ACTS: signing in and failing to, signing
// out, revoking a session, promoting and demoting, removing a member, inviting
// one, an invitation being accepted, an org being made or destroyed, and the four
// things that can be done to a cluster's access (connected, disconnected,
// credentials rotated, mode flipped). One row per act, never updated.
//
// Separate from `actions` rather than a nullable column on it, deliberately.
// `actions` hangs off a recommendation, cascades from a cluster, and ages out with
// the plan's history window; these are per ORG, some have no cluster at all, and
// they must not age out on a billing clock — the incident that needs them is
// usually older than the day it is noticed.
//
// Nothing cascades INTO this table for the same reason: every foreign key here is
// `set null`, so deleting an org, a cluster or a user cannot erase the trail of
// what was done to it. The names are kept alongside the ids (`actor_email`,
// `target`) so a row still reads after the row it pointed at is gone.
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // A SecurityEventName (src/audit/security-events.ts). Text, not an enum, for
    // the reason `actions.kind` is: recording a new kind of act should be a
    // constant, not a migration.
    event: text("event").notNull(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    // Set on the four cluster events; null on everything else, including a
    // sign-in, which belongs to no cluster.
    clusterId: uuid("cluster_id").references(() => clusters.id, { onDelete: "set null" }),
    // Who did it. Null for a failed sign-in, where the address typed is all there
    // is — and, deliberately, is recorded as the target rather than as the actor:
    // whoever it was did not prove they were that person.
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    // What it was done to, in whatever form the reader recognises: the member's
    // address, the cluster's name, the invited address, the session's id.
    target: text("target"),
    // The specifics of that act and nothing else — the roles either side of a
    // promotion, the mode a cluster was flipped to. Never credentials.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // Personal data, kept on purpose and no more of it than `session` already
    // holds: an incident asks which address and which client, and an answer of
    // "an owner, from somewhere, on something" is not one.
    //
    // Null rather than wrong when the address cannot be established. The api sees
    // a forwarded header, and reads it only when TRUST_PROXY says a proxy is in
    // front (env.ts) — recording the proxy's own address for every request would
    // be a column full of one number that looks like an answer.
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt,
  },
  (table) => [
    // Every read is one org's trail, newest first.
    index("security_events_org_time").on(table.orgId, table.createdAt.desc()),
    // "Everything this account did", which is the other question an incident
    // asks, and it crosses orgs.
    index("security_events_actor_time").on(table.actorUserId, table.createdAt.desc()),
    // Not for a reader — no page asks for one cluster's security events. It backs
    // the `set null` on cluster deletion, which would otherwise scan this table
    // every time a cluster is disconnected, and it is what the suite's
    // "no foreign key without an index" check asks for.
    index("security_events_cluster").on(table.clusterId),
  ],
);

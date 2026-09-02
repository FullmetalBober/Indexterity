import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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

// How privileged the credentials this cluster is held on actually are, recorded
// when they are stored rather than guessed from them later.
//
// The question it answers is one a reader could not otherwise ask: `readOnly`
// says what Indexterity is ALLOWED to do, and this says what it COULD do. A
// cluster held on an admin string is one where a mistake reaches further than
// indexes, and on PostgreSQL it is also the only shape that can apply at all —
// so it is worth showing rather than inferring from the absence of a provisioned
// username.
//
//   PROVISIONED  Indexterity created this user itself, so its ceiling is known
//                exactly: the scoped role and nothing more.
//   ADMIN        the stored string could create users or roles when it was
//                stored. It can do more than manage indexes.
//   SCOPED       pasted, and cannot create users. Narrower than ADMIN, and
//                unlike PROVISIONED its exact grants are the operator's business.
//
// Null for every cluster connected before this column existed: we never asked,
// and "we do not know" is not one of the three. Rendered as such rather than
// backfilled to a guess.
export const credentialPosture = pgEnum("credential_posture", ["PROVISIONED", "ADMIN", "SCOPED"]);
export const recommendationType = pgEnum("recommendation_type", [
  "DROP_UNUSED",
  "DROP_REDUNDANT",
  "MERGE",
  "CREATE",
  "UPDATE",
  "REORDER",
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
  //
  // No DDL default, deliberately (#132). It had one, `FREE`, and a default on a
  // column nobody wrote is not a fallback — it is the decision. The organization
  // plugin inserts without a plan, so `FREE` is what every self-hosted install
  // got while the chart asked for `SELF_HOSTED` and no code read the variable.
  // auth/organization.ts stamps it now, and a column that cannot fall back is
  // what makes a future path that forgets fail at the insert instead of quietly
  // choosing the most restrictive plan.
  plan: text("plan").notNull(),
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

// Org-level policy, as against the per-cluster knobs in `policies` further
// down. The distinction is WHEN each is read: a policy row is created after its
// cluster exists, so it cannot decide anything about connecting one, and the one
// rule here has to be in force before there is a cluster to hang it on (#313).
//
// A table rather than columns on `organizations`, which is better-auth's model
// (auth/organization.ts maps it): a column there is invisible to the plugin
// until it is declared as an `additionalFields` entry, and an org's security
// posture is not the plugin's business in the way its plan and its billing ids
// are. One row per org, keyed by the org, cascading with it — and absent until
// somebody saves, so "never configured" is a real state rather than a value.
//
// The DDL default is deliberate and is the opposite decision from #132's. There
// the default was standing in for a write nobody made, so `FREE` silently became
// the plan of every self-hosted install; here off IS the decision — an install
// that has said nothing about credential breadth has not asked us to refuse
// anybody's string, and turning that on for them retroactively would break every
// connect form in flight.
export const orgPolicies = pgTable("org_policies", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // Refuse to STORE credentials that can create users or roles — the connect
  // and rotate doors both check it (clusters/least-privilege.ts). Off by
  // default; see above.
  //
  // It does not reach backwards. Clusters already sealed on an admin string keep
  // collecting and are marked out of policy on their connection card instead,
  // because a setting that stopped analysis on eight clusters the moment it was
  // ticked is a setting nobody dares tick.
  requireLeastPrivilege: boolean("require_least_privilege").notNull().default(false),
  updatedAt,
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
// A WireGuard peering the control plane terminates in-process, so a cluster with
// no public endpoint becomes reachable (#353).
//
// The whole wg0.conf is sealed as one blob rather than split into columns, and
// that is deliberate. Only the [Interface] PrivateKey is a credential, so
// storing the endpoint and AllowedIPs in the clear would be defensible — but
// then two representations of one config exist and can drift, and the one that
// drifts silently is the AllowedIPs the guard enforces against. Unsealing to
// list them costs an AEAD decrypt.
//
// Orthogonal to connection_mode rather than a third value in it, which settles
// #353's first open question. "Reached over a tunnel" and "reached via a relay
// agent" are not mutually exclusive — an agent could itself sit behind a VPN —
// and an enum forces a choice the domain does not.
export const tunnels = pgTable(
  "tunnels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // What the owner calls it, since one org may peer with several networks.
    name: text("name").notNull(),
    // The pasted wg0.conf, envelope-encrypted exactly as a connection string is
    // (D8): it carries a private key of the same weight. keyVersion selects the
    // master key that sealed it so the KEK can rotate without re-sealing.
    sealedDek: bytea("sealed_dek").notNull(),
    sealedData: bytea("sealed_data").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    // One name per org, so the connect form can refer to a tunnel by something
    // a person chose rather than by a uuid.
    uniqueIndex("tunnels_org_name_key").on(table.orgId, table.name),
    index("tunnels_org_idx").on(table.orgId),
  ],
);

export const clusters = pgTable(
  "clusters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    connectionMode: connectionMode("connection_mode").notNull().default("HOSTED_DIRECT"),
    // Which tunnel reaches this cluster, or null for the ordinary case of a
    // cluster our egress can already open a socket to.
    //
    // RESTRICT rather than SET NULL on delete: a cluster silently losing its
    // tunnel would keep its connection string and start being dialled directly,
    // and the addresses in that string are private ones on somebody else's
    // network. Refusing the delete makes the owner detach the clusters first,
    // which is the decision they should be making anyway.
    tunnelId: uuid("tunnel_id").references(() => tunnels.id, { onDelete: "restrict" }),
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
    // Which of the cluster's databases the owner asked us to observe (#244).
    // NULL means every user database, which is what every row created before this
    // column existed means and what a scripted connect that sends nothing means —
    // so the default is the behaviour, not a migration.
    //
    // An allowlist of NAMES rather than a blocklist, because the question the
    // owner is answering is "look at these" and a blocklist would silently start
    // observing every database added to the cluster afterwards. The cost is the
    // mirror of that: a database added later is NOT observed until somebody says
    // so, which is why the settings screen counts the ones it is leaving out.
    //
    // Names that no longer exist are not an error and are not pruned: the filter
    // intersects this list with what the cluster reports each collect (see
    // jobs/cluster-connection.ts), so a dropped database simply stops matching
    // and a restored one starts again without the owner re-ticking it.
    observedDatabases: text("observed_databases").array(),
    // The least-privilege user Indexterity created on the cluster during
    // admin-string onboarding; null when the customer pasted a ready-made string.
    provisionedUsername: text("provisioned_username"),
    // Where that user was actually created, so the disconnect screen can name
    // the databases its removal has to visit (#338). PostgreSQL and SQL Server
    // both grant per database and both refuse a bare drop while those grants
    // remain; MongoDB's user is server-scoped, so this is empty for it.
    //
    // Written once, at provisioning, and never refreshed — deliberately. It
    // records what was DONE, not what exists now: provisioning runs from an
    // admin string that is never stored, so a database created afterwards has
    // no user of ours in it and needs no statement (the same gap the observe
    // selection's unreadable-database refusal already explains). Null on every
    // row that predates this column, and on rows with no provisioned user.
    provisionedDatabases: text("provisioned_databases").array(),
    // Set at connect and re-evaluated on every rotation, because rotating is
    // exactly when it changes: swapping an admin string for a scoped one is a
    // narrowing somebody should be able to see happened.
    // Why the pipeline is not running against this cluster, or null when it is.
    //
    // Stored rather than derived, which is the whole point. A cluster nobody can
    // reach produces no snapshots, so the only evidence on the dashboard was
    // `lastCollectedAt` going stale — and staleness has innocent causes (a paused
    // schedule, a plan window, a cluster with nothing left to collect). The
    // condition was known: `runClusterTask` records a metric, logs a line and
    // mails the owners once a day. None of that reaches a screen somebody opens
    // a week later, so the failure rendered as an absence, which reads as "all
    // is well" (#24's rule, arrived at again).
    //
    // Text, not an enum, for the reason `security_events.event` is text: adding
    // a reason should be a constant, not a migration.
    blockedReason: text("blocked_reason"),
    // When it STARTED, not when it was last seen — set on the first blocked pass
    // and left alone while it stays blocked, because "for six days" is the part
    // that decides whether somebody acts.
    blockedSince: timestamp("blocked_since", { withTimezone: true }),
    // The sentence, as the owner's own alert mail words it.
    blockedDetail: text("blocked_detail"),
    // WHICH pass stopped, beside why it stopped (#408).
    //
    // `runClusterTask` is handed the task name and already labels the metric
    // with it, and then dropped it here — so the dashboard could only guess, and
    // it guessed `collect` for every reason. That is harmless for a dial failure,
    // which stops every pass alike, and wrong for the ERROR reason, which is
    // exactly the one a non-collect pass lands on: a `suggest` that could not
    // finish was reported to the owner as collection failing, and sent the first
    // hour of diagnosis at the wrong pass.
    //
    // Text and not an enum, for the same reason `blocked_reason` is: adding a
    // pass should be a constant rather than a migration, which is only safe if
    // the reader degrades — so the contract types it as a string and the banner
    // renders a pass it does not know by name.
    blockedTask: text("blocked_task"),
    credentialPosture: credentialPosture("credential_posture"),
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
    // Every foreign key gets one, and the integration suite enforces it: without
    // it the RESTRICT on delete sequentially scans clusters, and so does every
    // lookup of what a tunnel reaches. A product about index hygiene shipping an
    // unindexed foreign key would be its own counterexample.
    index("clusters_tunnel_idx").on(table.tunnelId),
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

// Types that make the same CLAIM about one index. A DROP_UNUSED and a
// DROP_REDUNDANT both mean "this index should go", so one standing beside the
// other is a duplicate however differently they got there — and a constraint
// keyed on `type` would happily hold one of each. MERGE is a build: its
// `index_name` is the compound index it would CREATE, and the indexes it retires
// are in `target_spec.retire`.
//
// Here rather than in jobs/watched.ts, which is where they were and where the
// guards that read them still live, because the partial unique index below is
// built from the same three lists. Two copies of them would be exactly the kind
// of split-brain that index exists to remove.
export const DROP_TYPES = ["DROP_UNUSED", "DROP_REDUNDANT"] as const;
export const BUILD_TYPES = ["CREATE", "UPDATE", "MERGE", "REORDER"] as const;

// States a recommendation can be in while it is still going somewhere. DROPPED,
// ACTIVE, REJECTED and ROLLED_BACK are settled: the work happened or it will
// not, and re-deriving the finding is then correct rather than duplicative —
// classify is supposed to be able to propose dropping an index a graduated
// build put there, and a REJECTED drop is held off by a cooldown instead.
export const LIVE_STATES = [
  "PROPOSED",
  "APPROVED",
  "HIDDEN",
  "OBSERVE",
  "SCHEDULED",
  "BUILDING",
] as const;

// The enum literals as a SQL list, for the DDL below. `sql.raw` because
// drizzle-kit renders an index's expression into the migration verbatim, so a
// bound parameter would land in the file as a placeholder; the values are TS
// literals from the enums above and nothing here is user input.
const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

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
    // Days of trusted watch time behind this finding when it was proposed, or NULL
    // when usage is not the argument for it — a redundancy finding is provable from
    // the index list and rests on no span at all (#434).
    //
    // Stored rather than recomputed at promotion time, which is the trade worth
    // naming: promoteByScore is one UPDATE over the cluster's proposals, and asking
    // this question live would mean loading every index's usage history on every
    // tick inside the change window. Stale by at most one classify pass, and a
    // classify pass is what re-derives the row anyway.
    //
    // NULL therefore also means "written before this column existed", and that
    // reads as eligible on purpose: those rows are deleted and re-inserted by the
    // next classify pass, so failing them closed would freeze proposals that
    // already have months of evidence behind them for one cadence.
    evidenceDays: integer("evidence_days"),
    estimatedBytesSaved: bigint("estimated_bytes_saved", { mode: "number" }).notNull().default(0),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    // The observe window this drop actually got, decided at hide time from the
    // index's own usage history (analysis/observe.ts). Null = policy baseline.
    observeDays: integer("observe_days"),
    // Why it got that window, in the words analysis/observe.ts chose. Null when
    // the policy baseline applied unchanged and there is nothing to explain.
    //
    // A column rather than a join to the HIDE action that also records it: the
    // two are written in one statement and always read together, and recovering
    // this from `actions.result` would mean parsing it back out of a string
    // formatted for an audit trail.
    observeReason: text("observe_reason"),
    baselineReadOps: bigint("baseline_read_ops", { mode: "number" }),
    baselineReadLatency: bigint("baseline_read_latency", { mode: "number" }),
    // Failed operations on this namespace at hide time, and how far back the source
    // could see when that was sampled (#438). The pair the two columns above cannot
    // give: latencyStats counts a failed read and marks it in no way, and a failed
    // read is FASTER than a slow one, so a hide that breaks the workload reads as an
    // improvement to every gate that only knows latency.
    //
    // NULL means no source — the MongoDB profiler is opt-in, SQL Server's Query Store
    // may be off, and PostgreSQL counts per-relation failures nowhere at all. A NULL
    // here can never hold a drop back: the signal is one-way, so failures seen roll a
    // hide back and failures unseen decide nothing.
    baselineFailedOps: bigint("baseline_failed_ops", { mode: "number" }),
    baselineFailedReachMs: bigint("baseline_failed_reach_ms", { mode: "number" }),
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
      // REORDER only: the ORIGINAL index's options, carried verbatim so the
      // replacement enforces exactly what it replaced. Recorded at proposal
      // time rather than re-read at build time — by then the original may have
      // been changed by somebody else, and inheriting that silently is how an
      // option gets dropped. A missing `options` is an older row or another
      // type, and the build refuses a REORDER without one.
      options?: {
        unique: boolean;
        sparse: boolean;
        collation: string | null;
        partialFilter?: Record<string, unknown>;
        // Covering columns (SQL Server INCLUDE). A re-order rebuilds the index
        // with new key DIRECTIONS and everything else identical; leaving these
        // behind would quietly narrow what the replacement can answer, and the
        // post-build watch measures writes, so nothing downstream would see it.
        include?: string[];
      };
      // On the DROP_REDUNDANT row that retires a re-ordered index: the index
      // that replaced it. The only thing that lets a protected index be dropped
      // at all, and it is a claim rather than a permission — preflightDrop
      // re-checks it against live state at the moment of the drop.
      supersededBy?: string;
    }>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("recommendations_cluster_state").on(table.clusterId, table.state),
    // One live recommendation per index per claim (#283). Enforced only by
    // convention before this — three guard functions in jobs/watched.ts that
    // every producer has to remember to call and combine correctly, while the
    // schema would happily store two. There are three producer tags today and a
    // fourth that calls three of the four checks gets duplicates, with nothing
    // failing: the rows simply appear, and the first sign is a customer seeing
    // the same finding twice.
    //
    // It also closes a small race for free. `dispatchToAllClusters` gives each
    // task its own queue, so classify and suggest can run concurrently for one
    // cluster; each reads its guard sets and then inserts, and between those two
    // moments the other one's row can land. Narrow window, nothing structural
    // preventing it — and with `onConflictDoNothing` on the producers a losing
    // race is now a no-op rather than a duplicate row.
    //
    // The guard functions stay. They do more than deduplicate — they encode WHY
    // (a newborn index is not dead; an index leaving cannot cover) and that
    // reasoning is what writes the rationale a customer reads. This is the net
    // underneath, not a replacement.
    //
    // ADVISORY_REVIEW is deliberately OUT. Advisories are not drops and never
    // enter that pipeline, so classify already exempts them from the standing
    // check by hand; two different advisories about one index are a legitimate
    // thing to say, and constraining them here would enforce a rule the engine
    // never claimed.
    uniqueIndex("recommendations_one_live_claim")
      .on(
        table.clusterId,
        table.database,
        table.collection,
        table.indexName,
        sql.raw(`(case when "type" in (${quoted(DROP_TYPES)}) then 'DROP' else 'BUILD' end)`),
      )
      .where(sql.raw(`"state" in (${quoted(LIVE_STATES)}) and "type" <> 'ADVISORY_REVIEW'`)),
  ],
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
    // How to undo this action, and it is a different thing per kind — which was
    // invisible while the column was `Record<string, unknown>`. A DROP or HIDE
    // stores the serialized spec of the index it took away, because putting it
    // back means rebuilding everything it was (jobs/apply.ts, jobs/finalize.ts);
    // a CREATE stores only the name it added, because undoing that is a drop
    // (jobs/create.ts). Spelled as the union so a reader has to say which one it
    // is holding — `rollbackRecommendation` reads DROP rows and nothing reads
    // the CREATE variant yet.
    rollbackToken: jsonb("rollback_token").$type<
      { spec: Record<string, unknown> } | { indexName: string }
    >(),
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
  // On by default (#258). Every plan entitles it — FREE and self-host
  // included — so the old `false` was never a commercial gate, and it was
  // never a customer's choice either: the toggle had no state distinguishing
  // "off" from "never configured". Turning it on proposes CREATE/UPDATE/MERGE
  // rows and writes nothing to anybody's cluster; building is gated separately
  // on instantCreate, which stays off.
  workloadAnalysis: boolean("workload_analysis").notNull().default(true),
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

// "The last time we did X", for the two things that must not forget it when a
// process exits (#212).
//
// Burst mode is what forced this. The resident runner keeps both facts in the
// process — graphile-worker's cron holds the schedule, and the alert cooldown is
// a module-level Map — and both assume the process outlives the interval they
// describe. A burst tick is a whole process per tick, so on a fifteen-minute
// cron the cooldown would be empty 96 times a day and a cluster that has been
// unreachable since Tuesday would mail its owners 96 times.
//
// One table for both because it is one operation: claim this key if nothing
// claimed it since T. `pass:<name>` for a scheduled pass, `alert:<cluster>:<task>`
// for an alert. See jobs/watermark.ts — the claim is a single conditional upsert,
// so two ticks racing cannot both win it.
export const workerWatermarks = pgTable("worker_watermarks", {
  key: text("key").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
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
    // Nullable since D136, and the null means NEVER: an owner who cancels a drop
    // may say "do not touch this index again" rather than pick a date.
    //
    // A null rather than a date far in the future, because "never" is not a very
    // long time — a sentinel would eventually pass and the index would become
    // eligible again on a day nobody chose. Every reader has to say which it
    // means, which is the point: `activeCooldownKeys` treats null as active
    // forever, and the panel draws it as "never" rather than as a date.
    until: timestamp("until", { withTimezone: true }),
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

// One scanning query shape, and what the create side decided about it (#432).
//
// `collector.collectWorkload` returns every shape with `collscan`,
// `sortedInMemory`, `count`, `docsExamined` and `observedForHours`.
// `jobs/suggest.ts` read them once an hour, used them in memory, and persisted
// **only the recommendations that cleared every create-side gate** — so a query
// walking 900k documents a week on a small collection was seen, priced,
// discarded, and never mentioned to the customer. Every one of those gates is
// right; each worked by making the FINDING disappear along with the proposal,
// which is the same defect #277 fixed on the drop side.
//
// **One row per shape, not a time series.** `index_snapshots` is run-length
// encoded because an idle index reports byte-identical counters forever (D39),
// and that reasoning does not transfer: a shape worth reporting is one that KEEPS
// RUNNING, so its counters move on every pass and a counter-keyed run would
// collapse nothing in exactly the case worth collapsing. What the page actually
// asks — "was this scanning last week too, or did it start on Tuesday" — is
// answered by two timestamps, so the row carries `first_seen_at` and the newest
// reading and is upserted in place. Storage is then a function of how many
// distinct shapes the cluster HAS, which is the same property run-length
// encoding buys for the snapshot series by a longer route.
//
// **Only SCANNING shapes.** A shape the planner served from an index is not a
// finding, and storing it would make this table the size of the workload rather
// than the size of the problem.
//
// **`constants` is dropped on the way in, deliberately.** It is the one field
// here that carries real customer VALUES — only the profiler populates it, since
// `$queryStats` shapifies literals away, and the profiler is the workload source
// below MongoDB 8.0, which D94 shipped on by default. That decision accepted the
// trust cost of a TRANSIENT read; persisting the same values into our
// control-plane postgres is a different question with a different answer. The
// page has no use for a literal — it shows the shape an index would have to
// cover — so the values are used to derive a partialFilter candidate in memory
// and never written. See D128.
export const workloadShapes = pgTable(
  "workload_shapes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    database: text("database").notNull(),
    collection: text("collection").notNull(),
    // The shape itself: `{ equality, sort, range, collscan, sortedInMemory }`.
    // jsonb rather than five columns because it is ONE fact — the ESR split is
    // what an index would have to cover, and half of it is not a shape — and
    // because the digest below has to hash exactly what identifies a row.
    //
    // `collscan` and `sortedInMemory` are part of the shape rather than of the
    // measurement on purpose. They are different failures with different fixes,
    // and a shape that stops scanning and starts sorting in memory is a new
    // finding whose `first_seen_at` is the day it changed — not the same row
    // silently re-labelled.
    shape: jsonb("shape").$type<Record<string, unknown>>().notNull(),
    // The upsert's conflict target, generated by Postgres for the same reason
    // `cluster_indexes.spec_digest` is: jsonb is stored with its keys sorted, so
    // `shape::text` is already canonical, and a digest the writer computed
    // instead would have to reproduce that canonical form exactly — the day it
    // drifted, one shape would start inserting a second row per pass forever.
    shapeDigest: text("shape_digest")
      .notNull()
      .generatedAlwaysAs(sql`encode(sha256(shape::text::bytea), 'hex')`),
    // Executions, as the source reports them. CUMULATIVE from the store's own
    // start, not per pass — `$queryStats` accumulates for the life of the store
    // and the profiler's ring reports what it still holds — which is why the
    // rate is `executions / observed_for_hours` and not a difference between two
    // rows (D26). Storing the newest reading is therefore not losing a series;
    // the series was never what the number meant.
    executions: bigint("executions", { mode: "number" }).notNull(),
    // Documents the server actually walked. D40's urgency measure, and null
    // where the source cannot say: the profiler reports it, and `$queryStats`
    // only from mongo 8.0 — earlier stores carry execution counts alone. Zero
    // would be a claim that a collection scan walked nothing.
    docsExamined: bigint("docs_examined", { mode: "number" }),
    // How long this shape has been watchable, in hours — the denominator that
    // turns executions into a rate. Null when the source cannot say, which is
    // not the same as zero (D26).
    observedForHours: doublePrecision("observed_for_hours"),
    // Documents walked per week, and the severity tier — both computed by the
    // PASS and recorded, not re-derived on read.
    //
    // They have to be. Both need the collection's document count: `scanCost`
    // falls back to it when the source reports no `docsExamined` (the profiler
    // path, and every `$queryStats` entry below mongo 8.0), and `weeklyScanCost`
    // uses it the same way — "a collection scan walks the whole collection by
    // definition". That number is not a fact about the shape and is not stored
    // here, so a reader recomputing either value would get a different answer
    // from the one the engine decided by. Recording the verdict is also what
    // lets the page rank by cost in SQL, which is what the keyset cursor needs.
    //
    // Null when genuinely unmeasurable: a shape that only sorts in memory, whose
    // source reported no examined count, has no documents-walked figure at all —
    // and zero would read as "this costs nothing".
    weeklyDocsExamined: bigint("weekly_docs_examined", { mode: "number" }),
    // `ScanSeverity` from analysis/severity.ts, which grades SCANS. A shape that
    // only sorts in memory is ROUTINE by that measure and is not a minor problem
    // — a blocking sort dies at 100 MB — so the page draws `sortedInMemory` as
    // its own finding rather than this column being widened to mean two things.
    severity: text("severity").notNull(),
    // Who issued it: `{ application?, driver? }[]`. Operational metadata, not
    // customer data — an appName from a connection string — and the signal
    // behind `isWorthIndexing`, which is why a shape declined as interactive can
    // say so with the evidence beside it.
    clients: jsonb("clients").$type<{ application?: string; driver?: string }[]>().notNull(),
    // What the create side DID about this shape, in the words of
    // analysis/workload-outcome.ts. Text rather than an enum for the reason
    // `clusters.blocked_reason` is text: adding an outcome should be a constant,
    // not a migration, and an outcome written by a newer worker than the api
    // reading it must render as itself rather than fail the whole page.
    outcome: text("outcome").notNull(),
    // The index that WAS proposed, when one was. Null for every declined
    // outcome. Not a foreign key: `suggest.ts` deletes and re-inserts every
    // PROPOSED row it owns on each pass, so a reference would dangle by design
    // — and the name is what the reader wants to see anyway.
    proposedIndex: text("proposed_index"),
    // When this shape was first seen scanning, and when that was last true. The
    // pair is the whole answer to "is this new": a scan that appeared on Tuesday
    // and one that has been there for three months are the same row otherwise,
    // and they are not the same problem.
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // No default, for the reason `index_snapshots.last_seen_at` has none: a
    // caller that sets only `first_seen_at` would write a row claiming a
    // months-old reading was confirmed this instant, and this is the column
    // retention prunes by and the page dates itself from.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    // How many passes have seen this shape. The row count stopped being the
    // sample count the moment a row was upserted rather than appended.
    observations: integer("observations").notNull().default(1),
  },
  (table) => [
    uniqueIndex("workload_shapes_identity").on(
      table.clusterId,
      table.database,
      table.collection,
      table.shapeDigest,
    ),
    // The page's read: one cluster's shapes, worst first. Retention prunes by
    // `last_seen_at` within a cluster, which this also serves.
    index("workload_shapes_cluster_seen").on(table.clusterId, table.lastSeenAt),
  ],
);

// Why a pass had nothing to say, one row per cluster per producer (#277).
//
// The engine declining to make a finding is a state with no representation
// anywhere: an empty recommendations panel reads as "your indexes are all fine",
// and a cluster short of trustworthy history gets nothing from the usage gate
// with no sign anywhere that a gate is what it hit. `usageTrustRefusal` (#267)
// answers it per index and `indexterity.usage_trust.decisions` (#274) counts it
// for the operator; this is the customer's half.
//
// The `refusals` map is keyed by whatever the writing pass called its refusal,
// and readers look up only the kinds they know — so a kind that is retired stops
// being explained without a migration, and without an old row failing to load.
//
// Replaced whole on every pass rather than appended to, like cluster_rosters: the
// question is "why is it quiet NOW", and the history of that question is what the
// metric is for. Keyed by producer as well as cluster because the two engines
// fall silent for unrelated reasons — the usage gate refusing is nothing to do
// with a query-shape build being held back — and one row each keeps a pass from
// overwriting the other's account of itself.
//
// Both jsonb maps are keyed by the discriminated unions in analysis/silence.ts,
// so a new refusal kind or a new guard costs no migration. Explicit columns would
// have been twelve of them and a migration every time the gate grew a check.
export const analysisNotes = pgTable(
  "analysis_notes",
  {
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    source: recommendationSource("source").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    // Indexes the usage gate was asked about, and how many it trusted. Trusted is
    // the load-bearing one: usage analysis is PAUSED only when nothing cleared
    // the gate, and "some indexes are still warming up" is an ordinary state that
    // must not be reported as a fault.
    consideredIndexes: integer("considered_indexes").notNull().default(0),
    trustedIndexes: integer("trusted_indexes").notNull().default(0),
    // UsageTrustRefusal["kind"] -> how many indexes it refused.
    refusals: jsonb("refusals").$type<Record<string, number>>().notNull().default({}),
    // SuppressionGuard -> how many findings it withheld.
    suppressed: jsonb("suppressed").$type<Record<string, number>>().notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.clusterId, table.source] })],
);

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
    //
    // Loose here and checked at the writer: the shape differs per act, so the
    // column holds a union that `SecurityEventMetadata` (src/audit/security-
    // events.ts) declares one entry at a time, and `recordSecurityEvent` is the
    // only thing that writes this table. Typing it from there would point this
    // file up at a layer above it; nothing reads the column back, so the
    // per-act shape has to be enforced where it is spelled or nowhere.
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

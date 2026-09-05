// What the api *accepts*, as opposed to schemas.ts, which is what it returns.
//
// These were inline `z.object({ ... })` literals inside contract.ts, which was
// fine while only the api read them. The dashboard's forms validate the same
// fields, and a form that spells the rule a second time is a rule that drifts:
// the api starts rejecting something the button was happy to submit, and the
// reader gets a 400 for a mistake the field could have named.
//
// So the rules are named here, contract.ts composes them into route inputs, and
// the forms validate against the same objects (`.pick()`/`.omit()`-ed down to
// the fields they actually show). The messages are written to be read by a
// person standing in front of the field, because that is now one of their jobs
// — zod's defaults ("Too small: expected string to have >=1 characters") are
// wrong for a label even when they are right about the value.
import { z } from "zod";
import {
  CLUSTER_INDEXES_PAGE_MAX,
  clusterEngine,
  clusterPolicy,
  indexSortKey,
  orgPolicyView,
  sortDirection,
  tlsOverrides,
  WORKLOAD_SHAPES_PAGE_MAX,
  workloadSortKey,
} from "./schemas.js";

// Fields, shared by whichever inputs use them.
//
// Trimmed before the length check, so "   " is an empty name rather than a
// three-character one — and so `clusters_org_name` means what it says: without
// this, " staging" and "staging" are two different rows to the constraint and one
// indistinguishable pair to everybody reading the sidebar (#96).
export const clusterName = z.string().trim().min(1, "Give the cluster a name");
export const connectionString = z.string().min(1, "Paste a connection string");
export const orgName = z.string().min(1, "An org needs a name").max(120, "120 characters at most");
// Owner and member, and no third rung — see ORG_ROLES in apps/api/src/auth/
// organization.ts for why the plugin's `admin` is refused rather than adopted.
export const memberRole = z.enum(["member", "owner"]);
export const emailAddress = z.email("That does not look like an email address");

// better-auth's own minimum, which apps/api/src/auth/auth.config.ts sets from
// this constant rather than leaving to the library default — the sign-up form
// has to refuse exactly what the api would, and "8" written twice is how the
// two stop agreeing.
export const PASSWORD_MIN_LENGTH = 8;

// How recently a session must have been SIGNED IN for the acts that change what
// the engine may do to a customer's database: going live, rotating credentials,
// disconnecting. Holding an owner session is not the same claim as being the
// owner at the keyboard right now — a week-old tab on a borrowed laptop holds
// one and is not the other (#52).
//
// Shared because both sides act on it: the api refuses (SESSION_NOT_FRESH, see
// TenancyService.requireFreshOwner) and the dashboard explains the refusal and
// asks for the password again. An hour, not better-auth's day: long enough that
// connect-then-configure never trips it, short enough that "signed in recently"
// still means something.
export const SESSION_FRESH_AGE_SECONDS = 60 * 60;
export const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`);

// Clusters.
// Absent on all three below, and absent is the NORMAL case: the string says
// which engine it is (mongodb:// and mongodb+srv:// versus mssql://,
// sqlserver:// and the ADO `Server=…` list are disjoint), so the dashboard sends
// nothing here and a scripted connect need not know the field exists. It is sent
// only when detection claimed nothing and the reader said which engine it is —
// an override for the string nobody's guard recognises, never a picker in front
// of the ones they do.
// Which databases to observe, on the three routes that dial a cluster (#244).
//
// Optional, and absent means EVERY user database: that is what every cluster
// connected before this field existed does, and what a scripted connect that has
// never heard of it should keep doing. So the narrow behaviour is the one you ask
// for, never the one you get by not sending a field.
//
// `.min(1)` when present, because an empty array is a cluster nothing is ever
// collected from — indistinguishable, from every panel afterwards, from one that
// is broken. Untick the last box and the form refuses; disconnect the cluster if
// that is what you meant.
export const observedDatabases = z
  .array(z.string().min(1, "A database name cannot be empty"))
  .min(1, "Pick at least one database to observe");

// The edit-path payload, and the one place null is spelled out rather than left
// off: "observe all of them" has to be re-selectable after narrowing, and an
// absent field on a PUT is how you say "leave it alone" — a different sentence.
export const observedDatabasesInput = z.object({
  databases: observedDatabases.nullable(),
});

// Which tunnel reaches this cluster (#353). On the CONNECT input and not only
// on a later edit, because a database with no public endpoint cannot be dialled
// at all without it — checking the connection first and attaching the tunnel
// afterwards would mean the check could never pass for exactly the clusters
// this feature exists for.
export const tunnelSelection = z.uuid().nullable().optional();

export const createClusterInput = z.object({
  name: clusterName,
  connectionString,
  engine: clusterEngine.optional(),
  tunnelId: tunnelSelection,
  observedDatabases: observedDatabases.optional(),
  // Absent means all three off, which is what an older client and a plain
  // scripted connect both mean.
  tlsOverrides: tlsOverrides.optional(),
});

export const checkConnectionInput = z.object({
  connectionString,
  engine: clusterEngine.optional(),
  tunnelId: tunnelSelection,
  // Sent on a SECOND check, not the first: the first has no list to choose from
  // yet. It changes the verdict rather than only the plan — mongo's anyDb
  // requirements pass when every database in scope is covered (diagnose.ts,
  // `grants`), so credentials scoped to the one database somebody wants observed
  // read as ungranted while the whole cluster is in scope, and as granted once it
  // is not. Without this field the only way to connect that cluster is to widen a
  // grant over databases nobody asked us to read.
  observedDatabases: observedDatabases.optional(),
  // Checked with the same concessions the connect would store, or the preflight
  // would answer for a connection nobody is going to make.
  tlsOverrides: tlsOverrides.optional(),
});

export const provisionClusterInput = z.object({
  tunnelId: tunnelSelection,
  name: clusterName,
  adminConnectionString: connectionString,
  // Stored on the row, and that is all it does here — it does NOT narrow what the
  // provisioned user is granted, on either engine (#244). Provisioning runs once
  // from an admin string that is never kept, so a user granted only where this
  // pointed could never be widened; the selection has to stay editable, so it stays
  // a fact about what we look at.
  //
  // It still has to be accepted on THIS route as well as on createCluster, for the
  // reason #239 found the hard way: the reader who ticks boxes under a diagnosis
  // presses this button next, and a field the consent path did not take would
  // silently discard the choice they just made.
  observedDatabases: observedDatabases.optional(),
  // Here as well as on the two above, and it is not symmetry for its own sake:
  // the consent path re-reads the engine off the ADMIN string, so an override
  // that reached `checkConnection` and not this one would be forgotten by the
  // button the reader presses next — the same string, diagnosed as SQL Server
  // and then provisioned as mongo.
  engine: clusterEngine.optional(),
  // The admin string dials the same cluster as the scoped one it creates, so the
  // concession has to be made once and applies to both.
  tlsOverrides: tlsOverrides.optional(),
});

export const rotateConnectionInput = z.object({
  connectionString,
  tlsOverrides: tlsOverrides.optional(),
});

// The same field as the connect form's, deliberately: a name the create form
// accepts and the rename form refuses (or the reverse) is the drift this file
// exists to stop.
export const renameClusterInput = z.object({ name: clusterName });

// The engine knobs minus the cluster they belong to, which the route carries as
// a path param. Derived from the output schema so a knob cannot be settable and
// readable under two different rules.
export const policyKnobsInput = clusterPolicy.omit({ clusterId: true });

// The org's own policy, replaced whole the way the per-cluster knobs are. Derived
// from the output schema minus the field only the api writes, so a rule cannot be
// settable and readable under two different shapes (#313).
export const orgPolicyInput = orgPolicyView.omit({ updatedAt: true });

// Org and team. Not part of the oRPC contract any more — better-auth's
// organization plugin owns creating, renaming, inviting and the rest — but the
// forms still need one place to read the rules from, and the api's hooks refuse
// exactly these (organization.ts).
export const createOrgInput = z.object({ name: orgName });
export const renameOrgInput = z.object({ name: orgName });
export const createInviteInput = z.object({ email: emailAddress, role: memberRole });
// Nothing routes by slug — it exists because the plugin resolves organizations
// by one. Derived from the name rather than typed, so this is the shape the
// derivation has to produce, and the shape the api's hook checks for.
export const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Credentials. Not part of the oRPC contract — better-auth owns these routes —
// but the rules it enforces are still the api's rules, so the forms read them
// from the same place as everything else.
export const userName = z.string().min(1, "What should we call you?");
export const signInInput = z.object({ email: emailAddress, password });
export const signUpInput = signInInput.extend({ name: userName });
export const requestPasswordResetInput = z.object({ email: emailAddress });
export const resetPasswordInput = z.object({ password });

// The account page. The name rule is the sign-up form's, because they are the
// same field of the same row. The current password has no length rule — it is
// whatever it is, and the api's check is the only one that counts — while the
// new one is a password like any other being set.
export const updateNameInput = z.object({ name: userName });
export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, "Your current password"),
  newPassword: password,
});
// The same email rule sign-up applies — a change is a sign-up for the address.
export const changeEmailInput = z.object({ newEmail: emailAddress });

// The whole wg0.conf, pasted. Deliberately one textarea rather than a field per
// directive: it is what a VPN admin exports and what they can paste without
// transcribing, and the api parses it strictly so a config that means something
// other than what its author read is refused rather than half-accepted.
export const createTunnelInput = z.object({
  name: z.string().trim().min(1, "Name this tunnel").max(80),
  config: z
    .string()
    .min(1, "Paste the wg0.conf your VPN gave you")
    // Enough to catch an empty paste or the wrong file; the real validation is
    // the parser's, and its refusals name the exact directive.
    .max(16_384, "That is larger than any WireGuard config"),
});

// An edit to a tunnel already registered. Both fields are optional and at least
// one has to be present, because the two edits are asked for separately: a
// rename never needs the config re-pasted, and a rotated key or a moved gateway
// arrives as a whole new file. There is no partial config edit — the stored
// PrivateKey is never shown, so nothing on the dashboard could prefill a
// textarea for the owner to amend.
export const updateTunnelInput = z.object({
  name: z.string().trim().min(1, "Name this tunnel").max(80).optional(),
  config: z
    .string()
    .min(1, "Paste the wg0.conf your VPN gave you")
    .max(16_384, "That is larger than any WireGuard config")
    .optional(),
});

// Which tunnel reaches a cluster, or null to dial it directly.
export const clusterTunnelInput = z.object({ tunnelId: z.uuid().nullable() });

// The two paged reads (#431, #432): which page of the cluster's index inventory
// or of its scanning workload is being asked for. The cluster is the path param
// and everything else is the query string.
//
// Named here rather than written inline in contract.ts for the reason at the top
// of this file, and for a second one #455 found. The dashboard's page type was a
// hand copy of these fields, and a hand copy is how `sort`, `dir` and `q` joined
// the contract (D135) without ever reaching a request: the compiler accepts a
// variable of a wider type where a narrower object type is expected, so nothing
// said the copy was short. `ClusterIndexPage` and `WorkloadPage` in
// apps/web/src/lib/queries/telemetry.ts are derived from these now, so a field
// added here is a field there by construction.
export const clusterIndexesInput = z.object({
  clusterId: z.uuid(),
  // Exact, both of them, and `collection` without `database` is accepted: two
  // databases holding a collection of the same name is normal, and refusing the
  // narrower ask would only send the reader to page through the wider one.
  database: z.string().optional(),
  collection: z.string().optional(),
  // Where the page starts, in rows. Coerced because this arrives as a query
  // string; clamped rather than refused past the end, since a reader who filters
  // while on page five has asked for an offset that no longer exists and an empty
  // page would read as "this cluster has no indexes".
  offset: z.coerce.number().int().nonnegative().optional(),
  // How many rows the page carries. Bounded at both ends: the floor stops a
  // request for zero rows paging forever, and the ceiling is what keeps this
  // endpoint a page rather than a report — the reason it pages at all is that an
  // index list is unbounded.
  limit: z.coerce.number().int().min(1).max(CLUSTER_INDEXES_PAGE_MAX).optional(),
  // The order and the filter live HERE and not in the dashboard, because the
  // server decides which rows the page holds (D135). A control that orders the
  // hundred rows in front of the reader while the server chose WHICH hundred is
  // not sorting the cluster: "size descending" then means "the biggest of an
  // arbitrary hundred", which is the one reading nobody wants and the one it
  // looked like it was doing.
  sort: indexSortKey.optional(),
  dir: sortDirection.optional(),
  // Substring, case-insensitive, over `database.collection` and the index name.
  // Narrower than the client filter it replaces, which matched any rendered cell
  // — the flags and the key pattern are computed after the read, so they cannot
  // be a SQL predicate. Narrower in scope and wider in REACH: it searches the
  // cluster now rather than the page.
  q: z.string().trim().min(1).max(200).optional(),
});
export type ClusterIndexesInput = z.infer<typeof clusterIndexesInput>;

export const clusterWorkloadInput = z.object({
  clusterId: z.uuid(),
  database: z.string().optional(),
  collection: z.string().optional(),
  // Only the shapes nothing was proposed for, which is the question the page
  // exists to answer and the one no other screen can.
  declinedOnly: z.coerce.boolean().optional(),
  // Where the page starts and how big it is. Coerced from the query string, and
  // the limit is bounded at both ends for the reason the inventory gives: a floor
  // so a request for zero rows cannot page forever, and a ceiling that keeps this
  // a page rather than a report.
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(WORKLOAD_SHAPES_PAGE_MAX).optional(),
  // Same reasoning as the inventory above (D135). The default stays weekly cost
  // descending, which is the ranking this list exists to present.
  sort: workloadSortKey.optional(),
  dir: sortDirection.optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
export type ClusterWorkloadInput = z.infer<typeof clusterWorkloadInput>;

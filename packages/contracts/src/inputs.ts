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
import { clusterEngine, clusterPolicy, tlsOverrides } from "./schemas.js";

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

export const createClusterInput = z.object({
  name: clusterName,
  connectionString,
  engine: clusterEngine.optional(),
  observedDatabases: observedDatabases.optional(),
  // Absent means all three off, which is what an older client and a plain
  // scripted connect both mean.
  tlsOverrides: tlsOverrides.optional(),
});

export const checkConnectionInput = z.object({
  connectionString,
  engine: clusterEngine.optional(),
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

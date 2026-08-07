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
export const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`);

// Clusters.
export const createClusterInput = z.object({
  name: clusterName,
  connectionString,
  // Defaults to MONGODB — the only engine with an adapter today.
  engine: clusterEngine.optional(),
  // Absent means all three off, which is what an older client and a plain
  // scripted connect both mean.
  tlsOverrides: tlsOverrides.optional(),
});

export const checkConnectionInput = z.object({
  connectionString,
  engine: clusterEngine.optional(),
  // Checked with the same concessions the connect would store, or the preflight
  // would answer for a connection nobody is going to make.
  tlsOverrides: tlsOverrides.optional(),
});

export const provisionClusterInput = z.object({
  name: clusterName,
  adminConnectionString: connectionString,
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

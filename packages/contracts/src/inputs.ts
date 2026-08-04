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
import { clusterEngine, clusterPolicy } from "./schemas.js";

// Fields, shared by whichever inputs use them.
export const clusterName = z.string().min(1, "Give the cluster a name");
export const connectionString = z.string().min(1, "Paste a connection string");
export const orgName = z.string().min(1, "An org needs a name").max(120, "120 characters at most");
export const inviteToken = z.string().min(1, "Paste the invite token");
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
});

export const checkConnectionInput = z.object({
  connectionString,
  engine: clusterEngine.optional(),
});

export const provisionClusterInput = z.object({
  name: clusterName,
  adminConnectionString: connectionString,
});

export const rotateConnectionInput = z.object({ connectionString });

// The engine knobs minus the cluster they belong to, which the route carries as
// a path param. Derived from the output schema so a knob cannot be settable and
// readable under two different rules.
export const policyKnobsInput = clusterPolicy.omit({ clusterId: true });

// Org and team.
export const renameOrgInput = z.object({ name: orgName });
export const createInviteInput = z.object({ email: emailAddress, role: memberRole });
export const acceptInviteInput = z.object({ token: inviteToken });

// Credentials. Not part of the oRPC contract — better-auth owns these routes —
// but the rules it enforces are still the api's rules, so the forms read them
// from the same place as everything else.
export const signInInput = z.object({ email: emailAddress, password });
export const signUpInput = signInInput.extend({
  name: z.string().min(1, "What should we call you?"),
});
export const requestPasswordResetInput = z.object({ email: emailAddress });
export const resetPasswordInput = z.object({ password });

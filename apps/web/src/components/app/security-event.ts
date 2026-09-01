import type { SecurityEvent } from "@repo/contracts";
import { UNPROVEN_ACTOR_EVENTS } from "@repo/contracts";

// How one row of the security trail reads (#158).
//
// The rule that shapes this whole module: **a failed sign-in has no actor.**
// `SIGN_IN_FAILED` records the address that was typed as the TARGET and leaves
// `actor_user_id` null, deliberately, because whoever it was did not prove they
// were that person. A screen that renders every row as "<address> did <act>"
// turns that into an accusation against the account holder — who, in the row
// worth reading, is the victim of it.

type EventTone = "neutral" | "attempt" | "severe";

export interface EventLine {
  // The act, in words. Falls back to the stored name for a row written under an
  // act this build does not know: the column is text so that adding one is a
  // constant rather than a migration, and an unlabelled row still has to render.
  readonly label: string;
  // Who did it, or null when nobody proved they were anybody.
  readonly actor: string | null;
  // What it was done to, already worded for the act.
  readonly subject: string | null;
  readonly tone: EventTone;
}

const LABELS: Record<string, string> = {
  ACCOUNT_CREATED: "Account created",
  SIGN_IN: "Signed in",
  SIGN_IN_FAILED: "Failed sign-in",
  SIGN_OUT: "Signed out",
  SESSION_REVOKED: "Session revoked",
  TWO_FACTOR_ENABLED: "Two-factor enabled",
  TWO_FACTOR_DISABLED: "Two-factor disabled",
  TWO_FACTOR_VERIFIED: "Two-factor verified",
  TWO_FACTOR_FAILED: "Two-factor failed",
  TWO_FACTOR_CODES_REGENERATED: "Backup codes regenerated",
  TWO_FACTOR_OTP_SENT: "Sign-in code emailed",
  EMAIL_CHANGE_REQUESTED: "Email change requested",
  MEMBER_ROLE_CHANGED: "Role changed",
  MEMBER_REMOVED: "Member removed",
  MEMBER_LEFT: "Member left",
  INVITE_CREATED: "Invitation sent",
  INVITE_ACCEPTED: "Invitation accepted",
  ORG_CREATED: "Organization created",
  ORG_DELETED: "Organization deleted",
  CLUSTER_CONNECTED: "Cluster connected",
  CLUSTER_DISCONNECTED: "Cluster disconnected",
  CLUSTER_CREDENTIALS_ROTATED: "Credentials rotated",
  CLUSTER_MODE_CHANGED: "Mode changed",
  CLUSTER_OBSERVED_DATABASES_CHANGED: "Observed databases changed",
  ORG_POLICY_CHANGED: "Organization policy changed",
  TUNNEL_REGISTERED: "VPN tunnel registered",
  TUNNEL_UPDATED: "VPN tunnel changed",
  TUNNEL_REMOVED: "VPN tunnel removed",
  TUNNEL_TESTED: "VPN tunnel tested",
};

// The acts that take something away, or hand something over. Not "bad" — an
// owner disconnecting a cluster is ordinary work — but they are the rows an
// incident is read to find, so they are the ones worth spotting in a page of a
// hundred.
const SEVERE = new Set([
  "TWO_FACTOR_DISABLED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_REMOVED",
  "ORG_DELETED",
  "CLUSTER_DISCONNECTED",
  "CLUSTER_CREDENTIALS_ROTATED",
  "CLUSTER_MODE_CHANGED",
  // Severe in the direction that matters: widening it is how the control plane
  // starts reading a database it was not reading yesterday.
  "CLUSTER_OBSERVED_DATABASES_CHANGED",
  // Same asymmetry, and the same decision to mark both directions (#313):
  // switching least privilege OFF is what lets the next connect store an admin
  // string, and the row is worth finding whichever way it went.
  "ORG_POLICY_CHANGED",
  // A replaced wg0.conf is a key rotation on somebody's private network, and it
  // can move the network too — the tunnel act that belongs beside
  // CLUSTER_CREDENTIALS_ROTATED. A rename lands here as well rather than
  // splitting the act in two on the writing side; the detail says which it was.
  "TUNNEL_UPDATED",
  // Takes the route to every database behind it away, which is the shape of
  // CLUSTER_DISCONNECTED.
  "TUNNEL_REMOVED",
]);

export function eventLabel(event: string): string {
  return LABELS[event] ?? event;
}

// True for the acts where the address on the row is not somebody who did
// something. Read from the contract's list rather than spelled here, so the
// writer's rule and the screen's rule are one rule.
export function isUnprovenActor(event: string): boolean {
  // See organization.ts: `.some` compares without widening the receiver.
  return UNPROVEN_ACTOR_EVENTS.some((unproven) => unproven === event);
}

// The specifics, worded per act. Only the acts whose metadata says something a
// reader could not get from the row itself.
function detailFor(event: SecurityEvent): string | null {
  const metadata = event.metadata ?? {};
  if (event.event === "CLUSTER_MODE_CHANGED") {
    return metadata.readOnly === true ? "back to read-only" : "to live";
  }
  if (event.event === "MEMBER_ROLE_CHANGED" || event.event === "INVITE_CREATED") {
    return typeof metadata.role === "string" ? `as ${metadata.role}` : null;
  }
  if (event.event === "SESSION_REVOKED") {
    return metadata.scope === "others" ? "all other sessions" : null;
  }
  if (event.event === "CLUSTER_CONNECTED") {
    return metadata.provisioned === true ? "with a provisioned user" : null;
  }
  if (event.event === "ORG_POLICY_CHANGED") {
    // Which way it went, which is the whole content of this row — the label
    // already says a policy changed, and "changed" without a direction is the
    // thing #86 keeps arguing about in a different place.
    const to = metadata.to;
    if (typeof to !== "object" || to === null) return null;
    const required = Reflect.get(to, "requireLeastPrivilege");
    if (typeof required !== "boolean") return null;
    return required ? "least privilege now required" : "least privilege no longer required";
  }
  if (event.event === "TUNNEL_UPDATED") {
    // Which of the two edits this row is. A replaced config is the one worth
    // finding in a page of a hundred: a new PrivateKey, and possibly a
    // different network on the far side of it.
    if (metadata.config !== null && metadata.config !== undefined) return "config replaced";
    return metadata.name === null || metadata.name === undefined ? null : "renamed";
  }
  if (event.event === "TUNNEL_TESTED") {
    // The verdict, which is the whole reason the row is worth keeping: a run of
    // failed tests against one gateway is a story, and "tested" alone is not.
    return metadata.reachable === true ? "the gateway answered" : "no answer";
  }
  if (event.event === "TUNNEL_REGISTERED" || event.event === "TUNNEL_REMOVED") {
    // The gateway, because "a tunnel was registered" does not say which network
    // the control plane can now dial into.
    const endpoint = metadata.endpoint;
    return typeof endpoint === "string" && endpoint !== "" ? `gateway ${endpoint}` : null;
  }
  if (event.event === "CLUSTER_OBSERVED_DATABASES_CHANGED") {
    // The count, not the names. A twelve-database instance would push the rest of
    // the line off the row, and the names are in the metadata for the reader who
    // opens it — "to 2 databases" is what makes them decide to.
    const to = metadata.to;
    if (to === null) return "to every database";
    return Array.isArray(to) ? `to ${to.length} of them` : null;
  }
  return null;
}

export function eventLine(event: SecurityEvent): EventLine {
  const label = eventLabel(event.event);
  const detail = detailFor(event);
  const target = event.target === null ? null : event.target;
  if (isUnprovenActor(event.event)) {
    // No actor, and the address said as an attempt rather than as a deed. The
    // account holder did not do this — someone typed their address.
    return {
      label,
      actor: null,
      subject: target === null ? null : `attempted as ${target}`,
      tone: "attempt",
    };
  }
  const subject = [target, detail].filter((part) => part !== null && part !== "").join(" ");
  return {
    label,
    actor: event.actorEmail,
    subject: subject === "" ? null : subject,
    tone: SEVERE.has(event.event) ? "severe" : "neutral",
  };
}

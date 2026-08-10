import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import type { Plan } from "../billing/plans";
import { planFrom, withinLimit } from "../billing/plans";
import { seatsUsed } from "../billing/usage";
import { restoreHiddenIndexes } from "../clusters/offboard";
import { defaultOrgPlan } from "../config/env";
import { clusters, type Database, eq, organizations } from "../db";
import { sendMail } from "../mail/mailer";

// better-auth's organization plugin, wired onto the tables tenancy already had.
//
// What moved: creating and deleting an org, the switcher (session-scoped now),
// invites, last-owner protection, and the owner-only rule on every mutation —
// all of it the plugin's, none of it ours to maintain. What did NOT move is
// every plan limit. The plugin manages who is in an org; billing/plans.ts
// decides what that org may do, and a connected database is not a plugin
// concept.

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Owner and member, and deliberately not the plugin's third default role.
// `admin` would be a real third rung — it can invite, remove and rename — and
// half the api still asks the one question `TenancyService.requireOwner` asks:
// are you the owner? Adding the rung without teaching every mutation about it
// would produce an admin who can remove people but not connect a cluster, which
// is nobody's idea of an admin. Refused at the door instead, in both places a
// role can be chosen.
export const ORG_ROLES = ["owner", "member"] as const;

// A slug is not a product surface here — nothing routes by it, and it exists
// because the plugin resolves organizations by slug as well as by id. Validated
// rather than rewritten: the endpoint checks the submitted slug for a collision
// BEFORE this hook runs, so a hook that changed it would be checking one string
// and inserting another.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// A plan refusal, in the one shape the rest of the api uses for them: 402, and a
// message that names the limit and what to do about it. Not 403 — the caller is
// signed in and is an owner, so "forbidden" sends them looking for a permissions
// problem they do not have.
function planLimit(reason: string): APIError {
  return new APIError("PAYMENT_REQUIRED", { message: reason, code: "PLAN_LIMIT" });
}

async function planOf(db: Database, orgId: string) {
  const [row] = await db
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return planFrom(row?.plan);
}

function assertRole(role: string): void {
  // The plugin accepts a comma-separated list; we accept exactly one of two.
  if (!(ORG_ROLES as readonly string[]).includes(role)) {
    throw new APIError("BAD_REQUEST", { message: `role must be one of: ${ORG_ROLES.join(", ")}` });
  }
}

// Everything decided about an organization at the moment it is created: the
// slug is checked, and the plan the deployment asked for is stamped on.
//
// Exported and free of the database on purpose. It is the only place
// DEFAULT_ORG_PLAN is read, and a hook reachable only through better-auth is a
// hook nothing can pin — organization.test.ts calls this directly, which is the
// test #132 says was missing: `defaultOrgPlan()` had unit tests that passed
// while the function reached nothing.
export async function beforeCreateOrganization({
  organization: incoming,
}: {
  organization: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown> & { plan: Plan } }> {
  const slug = typeof incoming.slug === "string" ? incoming.slug : "";
  if (!SLUG.test(slug)) {
    throw new APIError("BAD_REQUEST", {
      message: "slug must be lowercase letters, digits and hyphens",
    });
  }
  // No cap on how many. A plan is bought per organization, so a limit here
  // would be a limit on how much a customer may buy — and the thing it would
  // protect, the free tier, is protected by the cluster cap that applies inside
  // every org one at a time.

  // The plan, and the whole of #132: `plan` is an `additionalFields` entry with
  // `input: false`, so it is not in the body the endpoint builds, and until this
  // line nothing put it there either. The column's DDL default — FREE — decided
  // instead, which meant every self-hosted install ran on the hosted free tier
  // (3 members, no unattended apply, 90 days) while the chart shipped
  // `DEFAULT_ORG_PLAN=SELF_HOSTED` and the variable reached the container and
  // stopped.
  //
  // Returned as data rather than written by an UPDATE afterwards, so the row is
  // never momentarily on a plan the deployment did not ask for — a worker
  // reading it in between would enforce the wrong limits.
  //
  // The spread is the plugin's own contract: it merges `data` over the request
  // body, and keys the organization model does not declare are dropped by the
  // adapter before the insert.
  return { data: { ...incoming, plan: defaultOrgPlan() } };
}

export interface OrganizationPluginConfig {
  // Where the dashboard lives, for the link in an invitation email.
  readonly webOrigin: string;
  // Mirrors emailAndPassword.requireEmailVerification. Stated rather than left
  // to the plugin, which infers it from whether it recognises the id generator
  // as opaque — ours is crypto.randomUUID, which it cannot know is unguessable,
  // so it would demand a verified email on every accept including in dev.
  readonly requireEmailVerification: boolean;
}

export function organizationPlugin(db: Database, config: OrganizationPluginConfig) {
  return organization({
    allowUserToCreateOrganization: true,
    // `organizationLimit` is deliberately unset even though it is the option
    // named for this. Its function form returns a BOOLEAN — "the limit is
    // reached" — and refuses with a bare 403 that names neither the limit nor
    // the remedy. Every other plan refusal in this codebase is a 402 that does
    // both, so the check lives in beforeCreateOrganization below instead.
    //
    // Same reasoning, opposite direction, for `membershipLimit`: it counts
    // members, ours counts members plus outstanding invites, and two limits
    // called the same thing is worse than one. Infinity hands the plugin no
    // opinion and leaves billing/plans.ts as the only answer.
    membershipLimit: () => Number.POSITIVE_INFINITY,
    invitationExpiresIn: INVITE_TTL_SECONDS,
    requireEmailVerificationOnInvitation: config.requireEmailVerification,
    // Re-inviting the same address replaces the stale invite rather than
    // refusing. The old behaviour of a second invite was a 400 telling an owner
    // something they had no way to fix from the dashboard.
    cancelPendingInvitationsOnReInvite: true,
    sendInvitationEmail: async ({ email, organization: org, inviter, invitation }) => {
      const who = inviter.user.name === "" ? inviter.user.email : inviter.user.name;
      await sendMail(
        email,
        `${who} invited you to ${org.name} on Indexterity`,
        `${who} invited you to join "${org.name}" as ${invitation.role}.\n\n` +
          `Sign in as ${email} and the invitation is waiting on the organization page:\n` +
          `${config.webOrigin}/app/org\n\n` +
          `It expires ${invitation.expiresAt.toISOString().slice(0, 10)}. ` +
          `Only ${email} can accept it.`,
      );
    },
    schema: {
      // Our table names and column names, unchanged. Ids stay uuid; see the
      // tenancy comment in db/schema.ts for why that was worth the mapping.
      organization: {
        modelName: "organizations",
        // Readable through the plugin, settable by nobody through it: `input:
        // false` keeps these out of the create and update bodies, so an owner
        // cannot POST themselves onto SCALE.
        additionalFields: {
          plan: { type: "string", required: false, input: false },
          planUpdatedAt: { type: "date", required: false, input: false },
          planNote: { type: "string", required: false, input: false },
          billingProvider: { type: "string", required: false, input: false },
          billingCustomerId: { type: "string", required: false, input: false },
          billingSubscriptionId: { type: "string", required: false, input: false },
        },
      },
      member: { modelName: "members", fields: { organizationId: "orgId" } },
      invitation: {
        modelName: "invites",
        fields: { organizationId: "orgId", inviterId: "invitedBy" },
      },
    },
    organizationHooks: {
      beforeCreateOrganization,

      beforeCreateInvitation: async ({ invitation }) => {
        assertRole(invitation.role);
        const orgId = invitation.organizationId;
        const plan = await planOf(db, orgId);
        const verdict = withinLimit(plan, "members", await seatsUsed(db, orgId));
        if (!verdict.allowed) throw planLimit(verdict.reason ?? "plan limit");
      },

      // The seat was reserved when the invite was sent, so this fires only when
      // the plan shrank in between. Checked anyway: a downgrade must not be
      // walked past by whoever happens to click a week-old link.
      beforeAcceptInvitation: async ({ invitation, organization: org }) => {
        const verdict = withinLimit(
          planFrom(org.plan as string | null | undefined),
          "members",
          await seatsUsed(db, org.id, invitation.id),
        );
        if (!verdict.allowed) throw planLimit(verdict.reason ?? "plan limit");
      },

      // The server-side addMember path, which accept-invitation does not use.
      beforeAddMember: async ({ member, organization: org }) => {
        assertRole(member.role);
        const verdict = withinLimit(
          planFrom(org.plan as string | null | undefined),
          "members",
          await seatsUsed(db, org.id),
        );
        if (!verdict.allowed) throw planLimit(verdict.reason ?? "plan limit");
      },

      beforeUpdateMemberRole: async ({ newRole }) => {
        assertRole(newRole);
      },

      // The dangerous one.
      //
      // An org is not a row. Cascades take our side of it — clusters, snapshots,
      // recommendations, ROI, policies — and touch nothing on the customer's
      // servers, where an index we hid stays hidden and a user we created stays
      // created. The first of those we can fix, and do, before the row goes.
      //
      // The second we cannot: dropping the provisioned user needs admin
      // credentials we deliberately never kept. The dashboard names those users
      // in the confirmation dialog (getOrg carries them) precisely because after
      // this point there is nothing left to name them from.
      beforeDeleteOrganization: async ({ organization: org }) => {
        const rows = await db
          .select({ id: clusters.id })
          .from(clusters)
          .where(eq(clusters.orgId, org.id));
        for (const row of rows) await restoreHiddenIndexes(db, row.id);
      },
    },
  });
}

import { randomBytes } from "node:crypto";
import { Controller, Req } from "@nestjs/common";
import { Implement, implement } from "@orpc/nest";
import { ORPCError } from "@orpc/server";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { requireUserId } from "../auth/session";
import { acceptOrgInvite, resolveMembership, resolveOrgId } from "../auth/tenancy";
import { and, eq, gt, invites, isNull, members, organizations, user } from "../db";
import { DatabaseService } from "../db/database.service";
import { sendMail } from "../mail/mailer";

const INVITE_TTL_MS = 7 * 86_400_000;

// Org membership + invites. Session required; everything scoped to the caller's org.
@Controller()
export class OrgController {
  constructor(private readonly database: DatabaseService) {}

  @Implement(contract.getOrg)
  getOrg(@Req() req: FastifyRequest) {
    return implement(contract.getOrg).handler(async () => {
      const userId = await requireUserId(req);
      const orgId = await resolveOrgId(this.database.db, userId);
      const [org] = await this.database.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const memberRows = await this.database.db
        .select({ userId: members.userId, role: members.role, email: user.email, name: user.name })
        .from(members)
        .innerJoin(user, eq(members.userId, user.id))
        .where(eq(members.orgId, orgId));
      const pending = await this.database.db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.orgId, orgId),
            isNull(invites.acceptedAt),
            gt(invites.expiresAt, new Date()),
          ),
        );
      return {
        id: orgId,
        name: org?.name ?? "",
        members: memberRows,
        pendingInvites: pending.map((invite) => ({
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
        })),
      };
    });
  }

  @Implement(contract.createInvite)
  createInvite(@Req() req: FastifyRequest) {
    return implement(contract.createInvite).handler(async ({ input }) => {
      const userId = await requireUserId(req);
      const member = await resolveMembership(this.database.db, userId);
      if (member.role !== "owner") {
        throw new ORPCError("FORBIDDEN", { message: "owner role required" });
      }
      const orgId = member.orgId;
      const token = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await this.database.db.insert(invites).values({
        orgId,
        email: input.email,
        role: input.role,
        token,
        invitedBy: userId,
        expiresAt,
      });
      const [org] = await this.database.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      // Best-effort: the token is also returned to the inviter to share manually.
      await sendMail(
        input.email,
        `You're invited to ${org?.name ?? "an org"} on Indexterity`,
        `You've been invited to join "${org?.name ?? "an org"}" as ${input.role}.\n\n` +
          `Sign up (or sign in), then paste this invite token in the Team section:\n\n` +
          `${token}\n\nThe invite expires ${expiresAt.toISOString().slice(0, 10)}.`,
      );
      return { token, email: input.email, role: input.role, expiresAt: expiresAt.toISOString() };
    });
  }

  @Implement(contract.acceptInvite)
  acceptInvite(@Req() req: FastifyRequest) {
    return implement(contract.acceptInvite).handler(async ({ input, errors }) => {
      const userId = await requireUserId(req);
      const [invite] = await this.database.db
        .select()
        .from(invites)
        .where(eq(invites.token, input.token))
        .limit(1);
      if (invite === undefined) throw errors.NOT_FOUND({ message: "invite not found" });
      if (invite.acceptedAt !== null) {
        throw errors.CONFLICT({ message: "invite already used" });
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        throw errors.CONFLICT({ message: "invite expired" });
      }
      const result = await acceptOrgInvite(this.database.db, userId, invite.orgId, invite.role);
      if (result === "already-member") {
        throw errors.CONFLICT({ message: "already a member of this org" });
      }
      await this.database.db
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(eq(invites.id, invite.id));
      const [org] = await this.database.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, invite.orgId))
        .limit(1);
      return { orgId: invite.orgId, orgName: org?.name ?? "" };
    });
  }
}

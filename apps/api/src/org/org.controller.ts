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

  // The caller's active org, owner role required (403 otherwise).
  private async requireOwnerOrg(req: FastifyRequest): Promise<string> {
    const userId = await requireUserId(req);
    const member = await resolveMembership(this.database.db, userId);
    if (member.role !== "owner") {
      throw new ORPCError("FORBIDDEN", { message: "owner role required" });
    }
    return member.orgId;
  }

  private async ownerCount(orgId: string): Promise<number> {
    const rows = await this.database.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.orgId, orgId), eq(members.role, "owner")));
    return rows.length;
  }

  @Implement(contract.renameOrg)
  renameOrg(@Req() req: FastifyRequest) {
    return implement(contract.renameOrg).handler(async ({ input }) => {
      const orgId = await this.requireOwnerOrg(req);
      const [updated] = await this.database.db
        .update(organizations)
        .set({ name: input.name })
        .where(eq(organizations.id, orgId))
        .returning({ id: organizations.id, name: organizations.name });
      if (updated === undefined) throw new Error("failed to rename organization");
      return updated;
    });
  }

  @Implement(contract.setMemberRole)
  setMemberRole(@Req() req: FastifyRequest) {
    return implement(contract.setMemberRole).handler(async ({ input, errors }) => {
      const orgId = await this.requireOwnerOrg(req);
      const [target] = await this.database.db
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.userId, input.userId)))
        .limit(1);
      if (target === undefined) throw errors.NOT_FOUND({ message: "member not found" });
      if (target.role === "owner" && input.role === "member") {
        // Demoting the last owner would strand the org with no one able to
        // manage it.
        if ((await this.ownerCount(orgId)) === 1) {
          throw errors.CONFLICT({
            message: "the last owner cannot be demoted — promote someone else first",
          });
        }
      }
      await this.database.db
        .update(members)
        .set({ role: input.role })
        .where(eq(members.id, target.id));
      return { userId: input.userId, role: input.role };
    });
  }

  @Implement(contract.removeMember)
  removeMember(@Req() req: FastifyRequest) {
    return implement(contract.removeMember).handler(async ({ input, errors }) => {
      const userId = await requireUserId(req);
      const member = await resolveMembership(this.database.db, userId);
      if (member.role !== "owner") {
        throw new ORPCError("FORBIDDEN", { message: "owner role required" });
      }
      if (input.userId === userId) {
        throw errors.CONFLICT({ message: "use leave to remove yourself" });
      }
      const [target] = await this.database.db
        .select()
        .from(members)
        .where(and(eq(members.orgId, member.orgId), eq(members.userId, input.userId)))
        .limit(1);
      if (target === undefined) throw errors.NOT_FOUND({ message: "member not found" });
      await this.database.db.delete(members).where(eq(members.id, target.id));
      return { removed: true };
    });
  }

  @Implement(contract.leaveOrg)
  leaveOrg(@Req() req: FastifyRequest) {
    return implement(contract.leaveOrg).handler(async ({ errors }) => {
      const userId = await requireUserId(req);
      const member = await resolveMembership(this.database.db, userId);
      if (member.role === "owner" && (await this.ownerCount(member.orgId)) === 1) {
        throw errors.CONFLICT({
          message: "you are the last owner — transfer ownership first",
        });
      }
      await this.database.db
        .delete(members)
        .where(and(eq(members.orgId, member.orgId), eq(members.userId, userId)));
      return { left: true };
    });
  }

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

  @Implement(contract.listOrgs)
  listOrgs(@Req() req: FastifyRequest) {
    return implement(contract.listOrgs).handler(async () => {
      const userId = await requireUserId(req);
      // Resolving first guarantees the lazy shell org exists for fresh accounts.
      const active = await resolveMembership(this.database.db, userId);
      const rows = await this.database.db
        .select({
          orgId: members.orgId,
          role: members.role,
          createdAt: members.createdAt,
          name: organizations.name,
        })
        .from(members)
        .innerJoin(organizations, eq(members.orgId, organizations.id))
        .where(eq(members.userId, userId));
      return rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({
          orgId: row.orgId,
          name: row.name,
          role: row.role,
          active: row.orgId === active.orgId,
        }));
    });
  }

  // Point every subsequent request at another of the caller's orgs. Exactly one
  // membership per user carries is_active after a switch.
  @Implement(contract.switchOrg)
  switchOrg(@Req() req: FastifyRequest) {
    return implement(contract.switchOrg).handler(async ({ input, errors }) => {
      const userId = await requireUserId(req);
      const [target] = await this.database.db
        .select({ role: members.role, name: organizations.name })
        .from(members)
        .innerJoin(organizations, eq(members.orgId, organizations.id))
        .where(and(eq(members.userId, userId), eq(members.orgId, input.orgId)))
        .limit(1);
      if (target === undefined) {
        throw errors.NOT_FOUND({ message: "not a member of that org" });
      }
      await this.database.db
        .update(members)
        .set({ isActive: false })
        .where(eq(members.userId, userId));
      await this.database.db
        .update(members)
        .set({ isActive: true })
        .where(and(eq(members.userId, userId), eq(members.orgId, input.orgId)));
      return { orgId: input.orgId, name: target.name, role: target.role, active: true };
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

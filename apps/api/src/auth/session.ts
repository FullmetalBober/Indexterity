import { ORPCError } from "@orpc/server";
import type { FastifyRequest } from "fastify";
import { auth } from ".";
import { toWebHeaders } from "./http";

export interface CallerSession {
  readonly userId: string;
  // Which org this session switched to, from the organization plugin. Null on a
  // session that has never switched, or whose org was deleted underneath it —
  // both fall back to the caller's oldest membership (auth/tenancy.ts).
  readonly activeOrgId: string | null;
}

// Authn: the caller's session, or 401. Tenancy scoping is layered on top.
export async function requireSession(req: FastifyRequest): Promise<CallerSession> {
  const session = await auth.api.getSession({ headers: toWebHeaders(req.headers) });
  if (session === null) throw new ORPCError("UNAUTHORIZED", { message: "sign in required" });
  return {
    userId: session.user.id,
    activeOrgId: session.session.activeOrganizationId ?? null,
  };
}

export async function requireUserId(req: FastifyRequest): Promise<string> {
  return (await requireSession(req)).userId;
}

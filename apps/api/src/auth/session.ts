import { UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { auth } from ".";
import { toWebHeaders } from "./http";

// Authn: the caller's user id, or 401. Tenancy scoping is layered on top.
export async function requireUserId(req: FastifyRequest): Promise<string> {
  const session = await auth.api.getSession({ headers: toWebHeaders(req.headers) });
  if (session === null) throw new UnauthorizedException();
  return session.user.id;
}

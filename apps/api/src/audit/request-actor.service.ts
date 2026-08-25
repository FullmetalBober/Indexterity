import { Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { requireSession } from "../auth/session";
import { type Database, eq, user } from "../db";
import type { RequestActor } from "./audit.types";

// Who is making this request, in the shape `security_events` records (#354).
//
// Its own provider rather than a second method on AuditService, because it
// imports the session — which reaches the auth instance, which imports
// AuditService to write its own rows. One class holding both closes that loop:
// auth.config -> audit -> auth/session -> auth/index -> auth.config, which vitest
// reports as "cannot access __vite_ssr_import__ before initialization" and node
// reports as a half-built module. The split is the dependency graph's, not a
// preference.
//
// Only reachable from the container by consequence: everything that resolves an
// actor is a controller or a service, and better-auth resolves its own with
// `getSessionFromCtx` instead (audit.utils.ts).
@Injectable()
export class RequestActorService {
  constructor(private readonly db: Database) {}

  async actorFromRequest(req: FastifyRequest): Promise<RequestActor> {
    const { userId } = await requireSession(req);
    const [row] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const agent = req.headers["user-agent"];
    return {
      actorUserId: userId,
      actorEmail: row?.email ?? null,
      ipAddress: req.ip === "" ? null : req.ip,
      userAgent: typeof agent === "string" ? agent : null,
    };
  }
}

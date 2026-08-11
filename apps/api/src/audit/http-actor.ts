import type { FastifyRequest } from "fastify";
import { requireSession } from "../auth/session";
import { type Database, eq, user } from "../db";

// Who is making this request, in the shape `security_events` records.
//
// The address comes from Fastify's own resolution, which already honours
// TRUST_PROXY (env.ts) — so a deployment that has not said a proxy is in front
// records the proxy's address rather than inventing a client, and one that has
// records the client. The better-auth side of the trail reads the header itself
// (audit/security-events.ts) because it is handed a synthetic Request with no
// socket behind it.
//
// The email is read alongside the id and stored with the row. `actor_user_id` is
// `set null` on user deletion, and a trail whose actor column empties when the
// account is deleted answers none of the questions it exists for.
export interface RequestActor {
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export async function actorFromRequest(db: Database, req: FastifyRequest): Promise<RequestActor> {
  const { userId } = await requireSession(req);
  const [row] = await db
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

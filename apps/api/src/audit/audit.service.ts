import { Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DatabaseService } from "../db/database.service";
import { actorFromRequest, type RequestActor } from "./http-actor";
import { recordSecurityEvent, type SecurityEventInput } from "./security-events";

// The trail's half that needs the pool (#354). Two things, and they are usually
// used together: work out who is asking, then write down what they did.
//
// What this buys over the functions it wraps: a controller or a service asking
// for a security-trail row stops reaching for `this.database.db` to do it. The
// pool belongs to whoever owns the writing, and that is here.
@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  // Who is making this request, resolved from its session.
  actorFromRequest(req: FastifyRequest): Promise<RequestActor> {
    return actorFromRequest(this.database.db, req);
  }

  // One row in the security trail. Best-effort by construction — see
  // `recordSecurityEvent`: the act already happened, so a failed insert is
  // reported and never escalated into a failed request.
  //
  // `warn` stays the CALLER's logger rather than one of this service's own. The
  // interesting question when a row is lost is which act lost it, and the answer
  // reads better under the controller that was performing it than under a shared
  // writer every feature funnels through.
  record(input: SecurityEventInput, warn: (message: string) => void): Promise<void> {
    return recordSecurityEvent(this.database.db, input, warn);
  }
}

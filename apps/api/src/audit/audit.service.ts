import { Injectable } from "@nestjs/common";
import { type Database, securityEvents } from "../db";
import type { SecurityEventInput } from "./audit.types";

// Writing the trail down. One pool and nothing else — which is what lets
// `auth/auth.config.ts` build one over its OWN pool (deliberately separate, so a
// slow report cannot starve a sign-in of a connection) at import time, before any
// container exists (#354).
//
// Resolving WHO is asking is deliberately not here, and the reason is a cycle
// rather than taste: it needs the session, the session needs the auth instance,
// and the auth instance is what imports this. RequestActorService holds that half
// — same directory, different dependency. Merging them puts
// auth.config -> audit -> auth/session -> auth/index -> auth.config back.
//
// The constructor takes the Database rather than DatabaseService, and
// audit.module.ts registers it with a factory that unwraps one, so the
// non-container caller above needs no cast.
@Injectable()
export class AuditService {
  constructor(private readonly db: Database) {}

  // Best-effort on purpose, and logged when it fails.
  //
  // The alternative — letting a failed insert fail the request — would mean a
  // momentary problem with this table could stop people signing in, and refusing
  // the sign-in does not un-record it either: the act already happened. So the row
  // is attempted after the act, and a loss is reported rather than escalated. The
  // same trade `storeCluster` makes for the first collect, and for the same reason.
  async record(
    input: SecurityEventInput,
    warn: (message: string) => void = () => {},
  ): Promise<void> {
    try {
      await this.db.insert(securityEvents).values({
        event: input.event,
        orgId: input.orgId ?? null,
        clusterId: input.clusterId ?? null,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        target: input.target ?? null,
        metadata: input.metadata ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });
    } catch (error) {
      warn(
        `could not record the security event ${input.event}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

import { Injectable } from "@nestjs/common";
import {
  type AuthHookContext,
  authTrailEntry,
  sessionEndedEntry,
  type TrailActor,
} from "./auth-trail";
import {
  authEventFor,
  clientFromHeaders,
  type SecurityEventInput,
  type SecurityEventName,
} from "./security-events";

// The trail's pure half, as a provider (#354): deciding WHICH event a request
// was, and building the row for it. No database and no request object — every
// one of these is a function of its arguments, which is why the drop side of
// this directory is the part that can be reasoned about without a server.
//
// Stated plainly rather than discovered later: nothing injects this yet. Its four
// helpers are called from `auth/auth.config.ts`, which builds better-auth at
// import time — before any container exists — and that construction is
// deliberately left alone (#354), so those calls keep importing the functions
// directly. This class is the door for the Nest side, and the reason the
// functions below stay exported is the hooks, not indecision.
@Injectable()
export class AuditUtils {
  // Which security event a better-auth path amounts to, or null for a path the
  // trail does not record.
  authEventFor(path: string, ok: boolean): SecurityEventName | null {
    return authEventFor(path, ok);
  }

  // The client's address and agent, and `trustProxy` is not optional on purpose:
  // reading `x-forwarded-for` from a request nobody put a proxy in front of is
  // reading a header the client set itself.
  clientFromHeaders(
    headers: Headers | undefined,
    trustProxy: boolean,
  ): { ipAddress: string | null; userAgent: string | null } {
    return clientFromHeaders(headers, trustProxy);
  }

  authTrailEntry(
    ctx: AuthHookContext,
    actor: TrailActor | null,
    trustProxy: boolean,
  ): SecurityEventInput | null {
    return authTrailEntry(ctx, actor, trustProxy);
  }

  sessionEndedEntry(input: {
    readonly path: string | null | undefined;
    readonly actor: TrailActor | null;
    readonly headers: Headers | undefined;
    readonly trustProxy: boolean;
  }): SecurityEventInput | null {
    return sessionEndedEntry(input);
  }
}

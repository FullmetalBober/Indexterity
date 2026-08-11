import { Res } from "@nestjs/common";
import type { AnySchema, ContractProcedure, ErrorMap, Meta } from "@orpc/contract";
import { Implement as OrpcImplement, implement as orpcImplement } from "@orpc/nest";
import type { FastifyRequest } from "fastify";
import type { Membership } from "../auth/tenancy";
import type { TenancyService } from "../http/tenancy.service";

type OrpcContract = Parameters<typeof OrpcImplement>[0];

// Drop-in replacement for @orpc/nest's `@Implement`.
//
// On Fastify the oRPC interceptor writes the reply itself and then resolves to
// `undefined`. Nest only skips its own send when the handler declares a
// `@Res()`/`@Next()` parameter, so without one it sends a second, empty reply
// and Fastify logs FST_ERR_REP_ALREADY_SENT for every oRPC route. Declaring the
// parameter here — one index past the handler's own arity, so it never clashes
// with a declared `@Req()` — means no route can forget it.
export function Implement<T extends OrpcContract>(
  contract: T,
): ReturnType<typeof OrpcImplement<T>> {
  const applyOrpc = OrpcImplement(contract);
  return (target, propertyKey, descriptor) => {
    applyOrpc(target, propertyKey, descriptor);
    Res()(target, propertyKey, descriptor.value?.length ?? 0);
  };
}

// How much a route asks of its caller. Every route names one, and `route()`
// below is the only way to build a handler, so naming one is not optional
// (#143). Ordered weakest to strongest; each level includes the one above it.
// No `public`: every route on the contract asks for at least a session, and the
// only anonymous endpoint this service has — the health check — is a plain Nest
// `@Get` that never comes through here. A level for a case that does not exist
// would be a hole nobody had asked for.
export const AUTH_LEVELS = [
  // Signed in. Says nothing about an organization, because the three reads the
  // dashboard shell makes have to answer for a caller who is in none yet.
  "session",
  // Signed in AND in an organization. Members read everything in theirs.
  "member",
  // Owner of that organization, with a second factor if the deployment demands
  // one of owners (REQUIRE_OWNER_2FA).
  "owner",
  // Owner, and signed in within the last hour. For the three acts whose blast
  // radius is the customer's database rather than this product (#52).
  "freshOwner",
] as const;

export type AuthLevel = (typeof AUTH_LEVELS)[number];

// What the gate leaves behind for the handler, narrowed by the level it asked
// for: an owner-level route reads `context.member.orgId` without checking
// whether there is one, because there could not have been a handler otherwise.
export type RouteScope<L extends AuthLevel> = L extends "session"
  ? { readonly userId: string; readonly member: Membership | null }
  : { readonly userId: string; readonly member: Membership };

// Runs the level, in the one place that cannot be skipped. A `session` caller
// who is in no organization gets a null membership rather than a refusal: being
// in none is a state the product has, not an error the api can fix.
async function enterScope(
  tenancy: TenancyService,
  req: FastifyRequest,
  level: AuthLevel,
): Promise<{ userId: string; member: Membership | null }> {
  const userId = await tenancy.userId(req);
  if (level === "session") return { userId, member: await tenancy.memberOrNull(req) };
  if (level === "member") return { userId, member: await tenancy.member(req) };
  const member =
    level === "owner" ? await tenancy.requireOwner(req) : await tenancy.requireFreshOwner(req);
  return { userId, member };
}

// The only way to implement a contract route, which is the point.
//
// Authorization used to be a line inside each handler — every route had one and
// every route had the right one, but a route that forgot would have been public
// and nothing said so: not the types, not a test (#143). Here it is an argument,
// so there is no handler without a level, and `biome.json` keeps @orpc/nest's
// own `implement` out of every other file so this stays the only door.
//
// An oRPC middleware rather than a Nest guard, deliberately. Nest runs guards
// BEFORE interceptors and @orpc/nest implements a route AS an interceptor, so a
// guard's refusal never reaches oRPC's codec: AppExceptionFilter would render
// the ORPCError as a 500 and every code the dashboard branches on
// (TWO_FACTOR_REQUIRED, SESSION_NOT_FRESH, PLAN_LIMIT) would stop arriving.
// Inside the pipeline they serialize as themselves.
//
// The resolved caller arrives on the handler's `context`, which is the other
// half: a decorator could refuse but had nowhere to put what it resolved, and
// that is why better-auth's own Nest package was turned down for this (D-log).
//
// Spelled out over the four schema parameters rather than `T extends
// ContractRouter`: oRPC picks the procedure implementer or the router one with a
// conditional type, and a generic router leaves that conditional deferred — so
// `.use` is not callable and every handler argument lands as `any`.
export function route<
  TInput extends AnySchema,
  TOutput extends AnySchema,
  TErrors extends ErrorMap,
  TMeta extends Meta,
  L extends AuthLevel,
>(
  tenancy: TenancyService,
  contract: ContractProcedure<TInput, TOutput, TErrors, TMeta>,
  req: FastifyRequest,
  level: L,
) {
  return orpcImplement(contract).use(async ({ next }) => {
    // The cast is the seam between a runtime switch and the level's type. Held
    // by enterScope above it and by RouteScope beside it; the alternative is
    // five near-identical overloads of this function.
    const scope = (await enterScope(tenancy, req, level)) as RouteScope<L>;
    return next({ context: scope });
  });
}

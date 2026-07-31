import { Res } from "@nestjs/common";
import { Implement as OrpcImplement } from "@orpc/nest";

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

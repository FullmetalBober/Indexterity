import { Controller, Req } from "@nestjs/common";
import { implement } from "@orpc/nest";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { TenancyService } from "../http/tenancy.service";
import { Implement } from "../orpc/implement";
import { ClusterEventsService } from "./cluster-events.service";

// How long one stream may live before the client has to reconnect. Ownership
// is checked once, at connect — a stream is not a request that can re-ask — so
// the lifetime is the bound on how long a revoked member keeps hearing a
// cluster. Five minutes to match the session cookie cache (auth.config.ts),
// which already sets that lag for every other read. The client's reconnect
// loop treats the end of a stream as routine, so the cost is one request per
// five minutes per open dashboard.
const STREAM_TTL_MS = 5 * 60_000;

@Controller()
export class EventsController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly events: ClusterEventsService,
  ) {}

  @Implement(contract.listClusterEvents)
  listClusterEvents(@Req() req: FastifyRequest) {
    // An arrow returning the subscription's generator, not an `async function*`
    // itself: the tenancy checks run — and refuse — before any stream exists,
    // and `this` survives into the handler.
    return implement(contract.listClusterEvents).handler(async ({ input, errors, signal }) => {
      const orgId = await this.tenancy.org(req);
      // NOT_FOUND rather than the read idiom's empty answer: an empty stream
      // does not end, it hangs — see the contract's note.
      if (!(await this.tenancy.ownsCluster(input.clusterId, orgId))) {
        throw errors.NOT_FOUND({ message: "cluster not found" });
      }
      const deadline = AbortSignal.timeout(STREAM_TTL_MS);
      const stop = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      return this.events.subscribe(input.clusterId, stop);
    });
  }
}

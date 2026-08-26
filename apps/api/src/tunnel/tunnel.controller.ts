import { Controller, Req } from "@nestjs/common";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { TenancyService } from "../http/tenancy.service";
import { Implement, route } from "../orpc/implement";
import { InvalidWireGuardConfError } from "./conf";
import { TunnelInUseError, TunnelService } from "./tunnel.service";

// Tunnels are org-scoped, not cluster-scoped: one peering commonly reaches
// several clusters on the same network, and a config per cluster would mean
// rotating a key in as many places as there are databases behind it.
//
// Reads are open to members — knowing a VPN exists is not sensitive, and the
// secret half never leaves the api. Writes are owner-only, because registering
// a peering decides where the control plane will open sockets.
@Controller()
export class TunnelController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly tunnels: TunnelService,
  ) {}

  @Implement(contract.listTunnels)
  listTunnels(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listTunnels, req, "member").handler(({ context }) =>
      this.tunnels.list(context.member.orgId),
    );
  }

  @Implement(contract.createTunnel)
  createTunnel(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.createTunnel, req, "owner").handler(
      async ({ input, errors, context }) => {
        try {
          return await this.tunnels.create(context.member.orgId, input.name, input.config);
        } catch (error) {
          // The parser's sentence, verbatim. It names the directive and why —
          // "[Peer] has no Endpoint, and Indexterity dials out" — which is the
          // only useful thing to say to somebody holding a file they did not
          // write. "Invalid config" would send them to their VPN admin with
          // nothing to relay.
          if (error instanceof InvalidWireGuardConfError) {
            throw errors.BAD_REQUEST({ message: error.message });
          }
          // A duplicate name in the same org: the unique index catches it, and
          // the name is how the connect form refers to a tunnel, so it has to
          // stay distinguishable.
          if (isUniqueViolation(error)) {
            throw errors.CONFLICT({ message: `you already have a tunnel called "${input.name}"` });
          }
          throw error;
        }
      },
    );
  }

  @Implement(contract.deleteTunnel)
  deleteTunnel(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.deleteTunnel, req, "owner").handler(
      async ({ input, errors, context }) => {
        if (!(await this.tunnels.ownedBy(input.tunnelId, context.member.orgId))) {
          throw errors.NOT_FOUND({ message: "no such tunnel" });
        }
        try {
          await this.tunnels.remove(input.tunnelId);
        } catch (error) {
          if (error instanceof TunnelInUseError) {
            throw errors.CONFLICT({ message: error.message });
          }
          throw error;
        }
        return { deleted: true as const };
      },
    );
  }
}

// 23505 lives on the CAUSE, not on the error drizzle throws.
function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === "23505";
}

import { Controller, Logger, Req } from "@nestjs/common";
import { contract, type TunnelView } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import type { SecurityEventDetails } from "../audit/audit.types";
import { RequestActorService } from "../audit/request-actor.service";
import { field, messageOf } from "../errors/message";
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
// a peering decides where the control plane will open sockets. The reachability
// test counts as one: it sends datagrams to a customer's gateway on demand, so
// it is not something a member should be able to do on a loop.
@Controller()
export class TunnelController {
  private readonly log = new Logger(TunnelController.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly tunnels: TunnelService,
    private readonly audit: AuditService,
    private readonly actors: RequestActorService,
  ) {}

  // After the act, never in front of it, and it cannot fail the request — the
  // same trade every other trail writer here makes: the act already happened,
  // and refusing the response would not un-record it.
  private async record(req: FastifyRequest, entry: SecurityEventDetails): Promise<void> {
    const actor = await this.actors.actorFromRequest(req);
    await this.audit.record({ ...entry, ...actor }, (message) => this.log.warn(message));
  }

  // What a tunnel reached, in the three fields the trail keeps of it. Never the
  // config: it carries a PrivateKey, and this table is read by people who are
  // not meant to be able to bring the peering up.
  private static reach(tunnel: TunnelView): {
    endpoint: string;
    allowedIps: string[];
    dns: string[];
  } {
    return {
      endpoint: tunnel.endpoint,
      allowedIps: [...tunnel.allowedIps],
      dns: [...tunnel.dns],
    };
  }

  @Implement(contract.listTunnels)
  listTunnels(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listTunnels, req, "member").handler(
      async ({ context }) => ({
        enabled: this.tunnels.enabled(),
        tunnels: await this.tunnels.list(context.member.orgId),
      }),
    );
  }

  @Implement(contract.createTunnel)
  createTunnel(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.createTunnel, req, "owner").handler(
      async ({ input, errors, context }) => {
        try {
          const tunnel = await this.tunnels.create(context.member.orgId, input.name, input.config);
          await this.record(req, {
            event: "TUNNEL_REGISTERED",
            orgId: context.member.orgId,
            target: tunnel.name,
            metadata: { tunnelId: tunnel.id, ...TunnelController.reach(tunnel) },
          });
          return tunnel;
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

  @Implement(contract.updateTunnel)
  updateTunnel(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.updateTunnel, req, "owner").handler(
      async ({ input, errors, context }) => {
        if (!(await this.tunnels.ownedBy(input.tunnelId, context.member.orgId))) {
          throw errors.NOT_FOUND({ message: "no such tunnel" });
        }
        try {
          const { tunnel, before } = await this.tunnels.update(input.tunnelId, {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.config === undefined ? {} : { config: input.config }),
          });
          await this.record(req, {
            event: "TUNNEL_UPDATED",
            orgId: context.member.orgId,
            target: tunnel.name,
            metadata: {
              tunnelId: tunnel.id,
              // Null when the field was not part of this edit, so a row says
              // which of the two acts it was rather than repeating a value that
              // did not move. A rename is recorded even though it is not a
              // security act: it changes what every other row here calls this
              // tunnel, and a trail has to be followable across it.
              name: before.name === tunnel.name ? null : { from: before.name, to: tunnel.name },
              config:
                input.config === undefined
                  ? null
                  : { from: TunnelController.reach(before), to: TunnelController.reach(tunnel) },
            },
          });
          return tunnel;
        } catch (error) {
          // Same two refusals a registration has, for the same reasons: the
          // parser's own sentence names the directive, and the org's unique
          // name is how the connect form refers to a tunnel.
          if (error instanceof InvalidWireGuardConfError) {
            throw errors.BAD_REQUEST({ message: error.message });
          }
          if (isUniqueViolation(error)) {
            throw errors.CONFLICT({ message: `you already have a tunnel called "${input.name}"` });
          }
          throw error;
        }
      },
    );
  }

  @Implement(contract.testTunnel)
  testTunnel(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.testTunnel, req, "owner").handler(
      async ({ input, errors, context }) => {
        if (!(await this.tunnels.ownedBy(input.tunnelId, context.member.orgId))) {
          throw errors.NOT_FOUND({ message: "no such tunnel" });
        }
        try {
          const { verdict, tunnel } = await this.tunnels.test(input.tunnelId);
          // After the answer rather than before the ask: what an incident wants
          // is what came back, and a row written on the way in could only say
          // somebody pressed a button.
          await this.record(req, {
            event: "TUNNEL_TESTED",
            orgId: context.member.orgId,
            target: tunnel.name,
            metadata: {
              tunnelId: tunnel.id,
              endpoint: tunnel.endpoint,
              reachable: verdict.reachable,
              health: verdict.health,
              error: verdict.error,
            },
          });
          return verdict;
        } catch (error) {
          // A gateway that does not answer is NOT this branch — that is a 200
          // with reachable:false, because it is the answer to the question.
          // This is the tunnel being untestable at all: a config that cannot be
          // unsealed after a master key rotated without its predecessor, or a
          // gateway address the network guard refuses outright. Both are facts
          // about the config, so neither is dressed up as "unreachable".
          throw errors.BAD_REQUEST({
            message: `this tunnel could not be brought up: ${messageOf(error)}`,
          });
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
          const removed = await this.tunnels.remove(input.tunnelId);
          await this.record(req, {
            event: "TUNNEL_REMOVED",
            orgId: context.member.orgId,
            target: removed.name,
            metadata: {
              tunnelId: removed.id,
              endpoint: removed.endpoint,
              allowedIps: [...removed.allowedIps],
            },
          });
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
  return field(field(error, "cause"), "code") === "23505";
}

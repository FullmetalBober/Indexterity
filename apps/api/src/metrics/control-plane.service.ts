import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { DatabaseService } from "../db/database.service";
import { registerControlPlaneGauges } from "./control-plane";

// The control-plane gauges, registered by the container instead of by hand (#354).
//
// This is the only thing in metrics/ with a dependency to declare. Everything else
// is either a process-global OpenTelemetry instrument (instruments.ts,
// provider.ts), a function that writes to one (jobs.ts), or bootstrap wiring that
// needs the Fastify instance and therefore belongs to main.ts (http.ts). Those stay
// as they are, for the same reason the Sentry client and the SMTP transport do:
// one per process is the correct number and there is nothing to inject.
//
// onApplicationBootstrap, which runs during app.init() and so still lands before
// listen — the ordering main.ts's comment cares about, since no measurement should
// predate the endpoint.
//
// The scrape-failure warning now goes through Nest's Logger rather than Fastify's.
// Same stdout, different format: this provider cannot reach the Fastify instance,
// and a gauge registration should not be the reason main.ts keeps holding the pool.
@Injectable()
export class ControlPlaneGaugesService implements OnApplicationBootstrap {
  private readonly log = new Logger(ControlPlaneGaugesService.name);

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    registerControlPlaneGauges(this.database.db, (message) => this.log.warn(message));
  }
}

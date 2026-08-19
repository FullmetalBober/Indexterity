import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { errorReportingEnabled } from "@repo/errors";
import { SentryModule } from "@sentry/nestjs/setup";
import { ClustersController } from "./clusters/clusters.controller";
import { DatabaseService } from "./db/database.service";
import { ClusterEventsService } from "./events/cluster-events.service";
import { EventsController } from "./events/events.controller";
import { HealthController } from "./health/health.controller";
import { TenancyService } from "./http/tenancy.service";
import { InsightsController } from "./insights/insights.controller";
import { TickController } from "./jobs/tick.controller";
import { TickService } from "./jobs/tick.service";
import { OrgController } from "./org/org.controller";
import { PolicyController } from "./policy/policy.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

// SentryModule is the SDK's Nest wiring only — NOT its SentryGlobalFilter, which
// is deliberately absent: AppExceptionFilter is this app's catch-all and decides
// which of the things it catches are faults (see errors/exception.filter.ts).
// What forRoot() actually registers is one APP_INTERCEPTOR, SentryTracingInterceptor.
//
// The IMPORT is unconditional (see errors/reporting.ts for why #176 tried
// otherwise and why that was reverted). Only the forRoot() CALL stays gated on a
// DSN, and that costs nothing to keep either way — SentryModule is already a real
// typed class reference, gating which array it lands in needs no require, no
// annotation, nothing to narrow. With no DSN this leaves an interceptor off every
// request that had nothing to trace: tracesSampleRate is 0 by decision (D28 put
// measurement on OpenTelemetry) and the client was never initialised.
function sentryImports() {
  return errorReportingEnabled() ? [SentryModule.forRoot()] : [];
}

@Module({
  // ORPCModule provides the interceptor that @Implement handlers run through.
  imports: [...sentryImports(), ConfigModule.forRoot({ isGlobal: true }), ORPCModule.forRoot({})],
  // One controller per area of the contract. They share TenancyService for the
  // session/ownership rules and http/mappers.ts for the boundary conversions.
  controllers: [
    HealthController,
    ClustersController,
    RecommendationsController,
    InsightsController,
    PolicyController,
    OrgController,
    EventsController,
    TickController,
  ],
  providers: [DatabaseService, TenancyService, ClusterEventsService, TickService],
})
export class AppModule {}

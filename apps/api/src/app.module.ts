import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { errorReportingEnabled } from "@repo/errors";
import { SentryModule } from "@sentry/nestjs/setup";
import { ClustersController } from "./clusters/clusters.controller";
import { DatabaseModule } from "./db/database.module";
import { ClusterEventsService } from "./events/cluster-events.service";
import { EventsController } from "./events/events.controller";
import { HealthController } from "./health/health.controller";
import { TenancyModule } from "./http/tenancy.module";
import { InsightsController } from "./insights/insights.controller";
import { TickController } from "./jobs/tick.controller";
import { TickService } from "./jobs/tick.service";
import { OrgController } from "./org/org.controller";
import { PolicyModule } from "./policy/policy.module";
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
  //
  // DatabaseModule and TenancyModule are imported rather than provided so that
  // the pool and the tenancy rules are ONE instance shared with the feature
  // modules below — listing the services here as well would give this module its
  // own second copy of each.
  //
  // Feature modules are the direction (#333): a controller still listed here is
  // one that has not moved yet, and this array shrinks to `imports` as they do.
  imports: [
    ...sentryImports(),
    ConfigModule.forRoot({ isGlobal: true }),
    ORPCModule.forRoot({}),
    DatabaseModule,
    TenancyModule,
    PolicyModule,
  ],
  // One controller per area of the contract. They share TenancyService for the
  // session/ownership rules and http/mappers.ts for the boundary conversions.
  controllers: [
    HealthController,
    ClustersController,
    RecommendationsController,
    InsightsController,
    OrgController,
    EventsController,
    TickController,
  ],
  providers: [ClusterEventsService, TickService],
})
export class AppModule {}

import { type DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { errorReportingEnabled } from "@repo/errors";
import { ClustersController } from "./clusters/clusters.controller";
import { DatabaseService } from "./db/database.service";
import { ClusterEventsService } from "./events/cluster-events.service";
import { EventsController } from "./events/events.controller";
import { HealthController } from "./health/health.controller";
import { TenancyService } from "./http/tenancy.service";
import { InsightsController } from "./insights/insights.controller";
import { OrgController } from "./org/org.controller";
import { PolicyController } from "./policy/policy.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

// SentryModule is the SDK's Nest wiring only — NOT its SentryGlobalFilter, which
// is deliberately absent: AppExceptionFilter is this app's catch-all and decides
// which of the things it catches are faults (see errors/exception.filter.ts).
// What forRoot() actually registers is one APP_INTERCEPTOR, SentryTracingInterceptor.
//
// Conditional, and the IMPORT is conditional with it (#176). `import { SentryModule }
// from "@sentry/nestjs/setup"` is itself what loads the SDK, so wrapping only
// `forRoot()` in a `dsn ? … : []` would have saved nothing — the module was in the
// require graph either way. With no DSN this leaves an interceptor off every
// request that had nothing to trace: tracesSampleRate is 0 by decision (D28 put
// measurement on OpenTelemetry) and the client was never initialised.
//
// Requiring here rather than in instrument.api.ts is safe because the ordering
// question is already settled by the time Nest reads this metadata: with a DSN,
// instrument.api.ts loaded the SDK before any other import of main.ts, so this is
// a cache hit; without one, there is nothing to order.
// Annotated and then checked, never asserted — same reasoning, and the same one
// name held to, as the note in errors/reporting.ts.
type SentrySetup = Pick<typeof import("@sentry/nestjs/setup"), "SentryModule">;

function sentryImports(): DynamicModule[] {
  if (!errorReportingEnabled()) return [];
  const setup: SentrySetup = require("@sentry/nestjs/setup");
  if (typeof setup.SentryModule?.forRoot !== "function") {
    throw new Error(
      "@sentry/nestjs/setup loaded without SentryModule.forRoot() — refusing to boot " +
        "with a DSN set and no instrumentation to show for it",
    );
  }
  return [setup.SentryModule.forRoot()];
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
  ],
  providers: [DatabaseService, TenancyService, ClusterEventsService],
})
export class AppModule {}

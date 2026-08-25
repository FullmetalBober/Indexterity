import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { errorReportingEnabled } from "@repo/errors";
import { SentryModule } from "@sentry/nestjs/setup";
import { ClustersModule } from "./clusters/clusters.module";
import { DatabaseModule } from "./db/database.module";
import { ErrorsModule } from "./errors/errors.module";
import { EventsModule } from "./events/events.module";
import { HealthModule } from "./health/health.module";
import { TenancyModule } from "./http/tenancy.module";
import { InsightsModule } from "./insights/insights.module";
import { JobsModule } from "./jobs/jobs.module";
import { OrgModule } from "./org/org.module";
import { PolicyModule } from "./policy/policy.module";
import { RecommendationsModule } from "./recommendations/recommendations.module";

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
  // Every feature is a module (#333, finished in #354), so this is the whole
  // application graph and nothing else: one `imports` list, no controller and no
  // provider of its own. A controller listed HERE would be one that has not been
  // given its module yet, and there are none left.
  imports: [
    ...sentryImports(),
    ConfigModule.forRoot({ isGlobal: true }),
    ORPCModule.forRoot({}),
    DatabaseModule,
    TenancyModule,
    ClustersModule,
    ErrorsModule,
    EventsModule,
    HealthModule,
    InsightsModule,
    JobsModule,
    OrgModule,
    PolicyModule,
    RecommendationsModule,
  ],
})
export class AppModule {}

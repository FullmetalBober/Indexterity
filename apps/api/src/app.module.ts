import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { SentryModule } from "@sentry/nestjs/setup";
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

@Module({
  // ORPCModule provides the interceptor that @Implement handlers run through.
  //
  // SentryModule is the SDK's Nest wiring only — NOT its SentryGlobalFilter,
  // which is deliberately absent: AppExceptionFilter is this app's catch-all and
  // decides which of the things it catches are faults (see errors/exception.filter.ts).
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true }),
    ORPCModule.forRoot({}),
  ],
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

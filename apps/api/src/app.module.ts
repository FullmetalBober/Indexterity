import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { ClustersController } from "./clusters/clusters.controller";
import { DatabaseService } from "./db/database.service";
import { HealthController } from "./health/health.controller";
import { TenancyService } from "./http/tenancy.service";
import { InsightsController } from "./insights/insights.controller";
import { OrgController } from "./org/org.controller";
import { PolicyController } from "./policy/policy.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

@Module({
  // ORPCModule provides the interceptor that @Implement handlers run through.
  imports: [ConfigModule.forRoot({ isGlobal: true }), ORPCModule.forRoot({})],
  // One controller per area of the contract. They share TenancyService for the
  // session/ownership rules and http/mappers.ts for the boundary conversions.
  controllers: [
    HealthController,
    ClustersController,
    RecommendationsController,
    InsightsController,
    PolicyController,
    OrgController,
  ],
  providers: [DatabaseService, TenancyService],
})
export class AppModule {}

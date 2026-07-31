import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ORPCModule } from "@orpc/nest";
import { DatabaseService } from "./db/database.service";
import { HealthController } from "./health/health.controller";
import { OrgController } from "./org/org.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

@Module({
  // ORPCModule provides the interceptor that @Implement handlers run through.
  imports: [ConfigModule.forRoot({ isGlobal: true }), ORPCModule.forRoot({})],
  controllers: [HealthController, RecommendationsController, OrgController],
  providers: [DatabaseService],
})
export class AppModule {}

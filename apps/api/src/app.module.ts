import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseService } from "./db/database.service";
import { HealthController } from "./health/health.controller";
import { OrgController } from "./org/org.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, RecommendationsController, OrgController],
  providers: [DatabaseService],
})
export class AppModule {}

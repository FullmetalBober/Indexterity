import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseService } from "./db/database.service";
import { HealthController } from "./health/health.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, RecommendationsController],
  providers: [DatabaseService],
})
export class AppModule {}

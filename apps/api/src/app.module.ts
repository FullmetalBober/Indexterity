import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AgentController } from "./agent/agent.controller";
import { DatabaseService } from "./db/database.service";
import { HealthController } from "./health/health.controller";
import { RecommendationsController } from "./recommendations/recommendations.controller";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, RecommendationsController, AgentController],
  providers: [DatabaseService],
})
export class AppModule {}

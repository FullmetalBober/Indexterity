import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { TenancyModule } from "../http/tenancy.module";
import { RecommendationsController } from "./recommendations.controller";
import { RecommendationsRepository } from "./recommendations.repository";
import { RecommendationsService } from "./recommendations.service";

@Module({
  imports: [DatabaseModule, TenancyModule],
  controllers: [RecommendationsController],
  providers: [RecommendationsService, RecommendationsRepository],
})
export class RecommendationsModule {}

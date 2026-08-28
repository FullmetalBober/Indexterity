import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { TenancyModule } from "../http/tenancy.module";
import { InsightsController } from "./insights.controller";
import { InsightsRepository } from "./insights.repository";
import { InsightsService } from "./insights.service";

// The first feature to earn a repository (#333). Nothing outside reads these
// views, so nothing is exported.
@Module({
  imports: [DatabaseModule, TenancyModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRepository],
})
export class InsightsModule {}

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { TenancyModule } from "../http/tenancy.module";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";

// The first feature module (#333). Nothing else needs the knobs yet, so the
// export list is empty — it grows when a second feature asks, not before.
@Module({
  imports: [DatabaseModule, TenancyModule],
  controllers: [PolicyController],
  providers: [PolicyService],
})
export class PolicyModule {}

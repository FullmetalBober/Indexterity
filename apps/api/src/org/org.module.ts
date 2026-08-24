import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { TenancyModule } from "../http/tenancy.module";
import { OrgController } from "./org.controller";
import { OrgService } from "./org.service";

// Nothing outside this feature reads an org through it yet — the plan checks
// every other feature makes go through TenancyService, which is cross-cutting
// rather than ours. So the export list stays empty until something asks.
@Module({
  imports: [DatabaseModule, TenancyModule],
  controllers: [OrgController],
  providers: [OrgService],
})
export class OrgModule {}

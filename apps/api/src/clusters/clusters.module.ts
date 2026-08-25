import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../db/database.module";
import { TenancyModule } from "../http/tenancy.module";
import { ClustersController } from "./clusters.controller";
import { ClustersRepository } from "./clusters.repository";
import { ClustersService } from "./clusters.service";

@Module({
  imports: [AuditModule, DatabaseModule, TenancyModule],
  controllers: [ClustersController],
  providers: [ClustersService, ClustersRepository],
})
export class ClustersModule {}

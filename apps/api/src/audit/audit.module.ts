import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { AuditService } from "./audit.service";
import { AuditUtils } from "./audit.utils";

// The security trail (#53), as a module (#354). Both providers are exported:
// unlike a feature module, this directory exists FOR its callers — every act
// worth recording happens somewhere else — so an empty export list would leave
// nothing able to record one.
@Module({
  imports: [DatabaseModule],
  providers: [AuditService, AuditUtils],
  exports: [AuditService, AuditUtils],
})
export class AuditModule {}

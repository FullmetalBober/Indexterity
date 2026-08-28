import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { DatabaseService } from "../db/database.service";
import { AuditService } from "./audit.service";
import { AuditUtils } from "./audit.utils";
import { RequestActorService } from "./request-actor.service";

// The security trail (#53), as a module (#354). Everything is exported: unlike a
// feature module, this directory exists FOR its callers — every act worth
// recording happens somewhere else — so an empty export list would leave nothing
// able to record one.
//
// Three providers and not two, because resolving an ACTOR needs the session and
// writing a ROW does not. See request-actor.service.ts: one class holding both
// closes an import cycle through the auth instance.
//
// AuditService is registered through a factory rather than by class, because its
// constructor asks for the Database and not the service that holds one. That is
// what lets `auth/auth.config.ts` build one over its own pool with no cast — see
// the note on the class.
@Module({
  imports: [DatabaseModule],
  providers: [
    AuditUtils,
    {
      provide: AuditService,
      useFactory: (database: DatabaseService) => new AuditService(database.db),
      inject: [DatabaseService],
    },
    {
      provide: RequestActorService,
      useFactory: (database: DatabaseService) => new RequestActorService(database.db),
      inject: [DatabaseService],
    },
  ],
  exports: [AuditService, AuditUtils, RequestActorService],
})
export class AuditModule {}

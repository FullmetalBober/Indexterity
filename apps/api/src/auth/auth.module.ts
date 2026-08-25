import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { DatabaseService } from "../db/database.service";
import { GatesService } from "./gates.service";

// Sessions, sign-up and the second factor (#354).
//
// One provider. The rest of this directory is deliberately suffix-less, and that
// is the answer to the naming gap rather than a hole in it: Nest has a suffix for
// a controller, a service, a guard, a filter and a pipe, and none for "a
// module-scope function better-auth is handed at import time", which is what
// `auth.config.ts`, `organization.ts`, `rate-limit.ts`, `cookies.ts`, `http.ts`
// and `session.ts` are. Renaming them would advertise a role they do not have.
//
// `index.ts` stays the composition point for the auth instance: it is built at
// import time, over a pool of its own so a slow report cannot starve a sign-in of
// a connection, and that was skipped by decision on #354.
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: GatesService,
      useFactory: (database: DatabaseService) => new GatesService(database.db),
      inject: [DatabaseService],
    },
  ],
  exports: [GatesService],
})
export class AuthModule {}

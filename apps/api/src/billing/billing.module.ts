import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { DatabaseService } from "../db/database.service";
import { UsageService } from "./usage.service";

// Plans and what is spent against them (#354).
//
// `plans.ts` is not a provider and should not become one: `entitlementsFor`,
// `withinLimit`, `limitFor` and the rest are pure functions of a plan name with
// nothing to inject, they are read from better-auth hooks and a CLI script as well
// as from Nest, and a class around them would cost inference and buy nothing.
//
// Counting seats needs the pool, so that half is a provider.
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: UsageService,
      useFactory: (database: DatabaseService) => new UsageService(database.db),
      inject: [DatabaseService],
    },
  ],
  exports: [UsageService],
})
export class BillingModule {}

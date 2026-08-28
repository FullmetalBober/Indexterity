import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { DatabaseModule } from "../db/database.module";
import { DialBudgetService } from "./dial-budget.service";
import { AppExceptionFilter } from "./exception.filter";

// What this app does with a failure (#354).
//
// Two things live here and only one is a provider, which is the rule this issue
// settled: `unreachable.ts` and `reporting.ts` keep their exported functions
// because neither holds anything to inject — one is a predicate over an error, and
// the other hands a captured error to a Sentry client that `instrument.api.ts`
// initialises before Nest exists, by requirement. A class around either would be a
// decorator on a namespace.
//
// The filter moves in as APP_FILTER rather than staying `new AppExceptionFilter()`
// in main.ts. It is the one thing in this directory that was already a Nest
// artefact being constructed by hand, and the container is where a Nest artefact
// belongs — it can also take a dependency now without main.ts having to know.
// Sentry's own global filter stays deliberately absent; this one is the catch-all
// and decides which failures are faults.
@Module({
  imports: [DatabaseModule],
  providers: [DialBudgetService, { provide: APP_FILTER, useClass: AppExceptionFilter }],
  exports: [DialBudgetService],
})
export class ErrorsModule {}

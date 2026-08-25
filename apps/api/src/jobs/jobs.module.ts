import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { TickController } from "./tick.controller";
import { TickService } from "./tick.service";

// The scheduler and its external tick endpoint (#354).
//
// `TickService` is exported because main.ts reaches for it with `app.get` to
// start the in-process interval — `app.get` resolves across the whole container
// whether or not a module exports it, so the export is documentation: this
// provider is deliberately reachable from the composition root, and that is the
// only place outside this module that touches it.
@Module({
  imports: [DatabaseModule],
  controllers: [TickController],
  providers: [TickService],
  exports: [TickService],
})
export class JobsModule {}

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { ControlPlaneGaugesService } from "./control-plane.service";

// What this deployment reports about itself (#354).
//
// One provider, and it is the only thing here that holds anything: the gauges read
// the api's OWN pool, which is why they moved off the jobs' pool in the first
// place — an api serving no jobs was opening a second pool to answer a scrape.
//
// The metrics SERVER stays in main.ts. It is a second HTTP listener with its own
// port and its own SIGTERM handling, and the composition root is where that
// belongs.
@Module({
  imports: [DatabaseModule],
  providers: [ControlPlaneGaugesService],
})
export class MetricsModule {}

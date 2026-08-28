import { Module } from "@nestjs/common";
import { TenancyModule } from "../http/tenancy.module";
import { ClusterEventsService } from "./cluster-events.service";
import { EventsController } from "./events.controller";

// The SSE fan-out (#354). `ClusterEventsService` is NOT exported: it owns one
// LISTEN connection and the emitter every subscriber hangs off, and the only
// caller is the controller beside it. A second module reaching in would be a
// second reason for that connection to exist.
@Module({
  imports: [TenancyModule],
  controllers: [EventsController],
  providers: [ClusterEventsService],
})
export class EventsModule {}

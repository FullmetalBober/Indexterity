import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

// The liveness probe, and the one module with nothing in it but a controller:
// the endpoint answers from process state alone, so there is no service to hold
// and nothing for anybody else to import (#354).
@Module({
  controllers: [HealthController],
})
export class HealthModule {}

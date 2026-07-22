import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ClustersController } from "./clusters/clusters.controller";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, ClustersController],
})
export class AppModule {}

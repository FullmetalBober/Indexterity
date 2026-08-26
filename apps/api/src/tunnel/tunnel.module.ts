import { Module } from "@nestjs/common";
import { DatabaseModule } from "../db/database.module";
import { TenancyModule } from "../http/tenancy.module";
import { TunnelController } from "./tunnel.controller";
import { TunnelRegistry } from "./tunnel.registry";
import { TunnelService } from "./tunnel.service";

// The registry is exported because the job pipeline reaches it (through
// tunnel/current.ts) and because nothing else should construct a second one.
//
// No ClustersModule import, deliberately: assigning a tunnel to a cluster is a
// route on ClustersController, so the dependency runs one way — clusters know
// about tunnels, tunnels do not know about clusters. Putting that route here
// made the two modules import each other, and a forwardRef would have hidden
// the cycle rather than removed it.
@Module({
  imports: [DatabaseModule, TenancyModule],
  controllers: [TunnelController],
  providers: [TunnelRegistry, TunnelService],
  exports: [TunnelRegistry, TunnelService],
})
export class TunnelModule {}

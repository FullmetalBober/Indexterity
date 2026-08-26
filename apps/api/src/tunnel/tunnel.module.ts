import { Module } from "@nestjs/common";
import { TunnelRegistry } from "./tunnel.registry";

// One provider, exported. There is no controller here on purpose: a tunnel is
// not a resource anybody addresses directly — it is how a cluster is reached,
// so it is registered and inspected through the cluster that owns it.
@Module({
  providers: [TunnelRegistry],
  exports: [TunnelRegistry],
})
export class TunnelModule {}

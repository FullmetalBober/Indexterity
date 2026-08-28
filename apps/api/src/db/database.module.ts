import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";

// The control-plane connection, as something a feature module can ask for.
//
// One provider, deliberately exported rather than global: DatabaseService opens
// a pool in a field initialiser and drains it in onApplicationShutdown, so a
// second instance would be a second pool nobody counted — which is exactly what
// happens if a feature module lists the service in its own `providers` instead
// of importing this. Naming the dependency costs one import line per feature and
// makes that mistake unavailable.
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}

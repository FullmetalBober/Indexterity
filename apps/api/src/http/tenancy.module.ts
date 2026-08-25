import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { DatabaseModule } from "../db/database.module";
import { TenancyService } from "./tenancy.service";

// The session/ownership rules every feature asks the same questions of.
//
// Cross-cutting rather than a feature of its own: `route()` takes a
// TenancyService to run a route's auth level, so a module with a controller
// imports this whether or not it names the service itself.
@Module({
  imports: [BillingModule, DatabaseModule],
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}

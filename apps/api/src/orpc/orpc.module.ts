import { Module } from "@nestjs/common";

// The contract-to-controller helpers (#354).
//
// No providers, and none is possible. `Implement` is used as
// `@Implement(contract.listClusters)` — a method decorator applied when the class
// is DEFINED, before any container exists — and `route()` is called inside a
// handler with the request in hand. Neither can be injected, whatever the tree
// looks like.
//
// Named ORPC helpers rather than OrpcModule to keep it clear of @orpc/nest's own
// ORPCModule, which app.module.ts imports for the interceptor.
@Module({})
export class OrpcHelpersModule {}

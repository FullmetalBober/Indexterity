import { Module } from "@nestjs/common";

// The engine-neutral boundary (#354).
//
// No providers. Ports, types and the registry are read by the adapters, which are
// constructed per cluster from a connection string at runtime — they cannot be
// singletons, so there is nothing here for the container to own.
@Module({})
export class EngineModule {}

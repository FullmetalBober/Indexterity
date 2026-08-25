import { Module } from "@nestjs/common";

// The MongoDB adapter (#354).
//
// No providers. A MongoConnection is built per cluster from a connection string
// and closed with the lease that opened it; a singleton would be one customer's
// credentials shared across every request. The adapter is reached through
// engine/registry.ts, which is how the other two are reached as well.
@Module({})
export class MongoAdapterModule {}

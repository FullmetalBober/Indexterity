import { Module } from "@nestjs/common";

// The SQL Server adapter (#354).
//
// No providers, for the reason the other two adapters have none: one connection
// per cluster, built from a connection string and closed with its lease.
@Module({})
export class MssqlAdapterModule {}

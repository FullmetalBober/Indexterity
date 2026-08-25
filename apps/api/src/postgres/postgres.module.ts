import { Module } from "@nestjs/common";

// The PostgreSQL adapter (#354).
//
// No providers, for the reason mongo's has none — and one more of its own: this
// connection holds a pool PER DATABASE, opened lazily and dropped with the
// session, because a postgres connection is bound to one database for life. That
// is a per-lease lifetime, not a container one.
@Module({})
export class PostgresAdapterModule {}

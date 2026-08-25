import { Module } from "@nestjs/common";

// The validated environment (#354).
//
// No providers, and that is the point rather than an omission. `apiEnv()`,
// `workerEnv()` and `coreEnv()` are read at module scope — `auth/index.ts:6` does
// it — and by main.ts BEFORE Nest starts, because validating the environment is
// what lets the container start at all. A provider could not be asked before it
// exists.
//
// The module is the directory's declared unit: it is where an export list goes the
// day something here is worth injecting, and its absence would read as an
// oversight rather than as a decision.
@Module({})
export class ConfigEnvModule {}

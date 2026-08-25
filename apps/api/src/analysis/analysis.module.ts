import { Module } from "@nestjs/common";
import { CostUtils } from "./cost.utils";
import { SafetyUtils } from "./safety.utils";

// The analysis half, as providers (#354).
//
// Nothing here holds a pool, a socket or a clock: every method is a function of
// its arguments, which is the property the drop pipeline's safety rests on and the
// reason this directory has the deepest test coverage in the repo. The providers
// keep it — they are constructed, not booted, and their tests still call methods
// with fixtures rather than standing a container up.
//
// One provider per concern rather than one class with sixty-six methods, and each
// constructor names exactly the other concerns it reads. That graph is acyclic and
// worth keeping so: `client` and `safety` are leaves, `workload` reads them,
// `severity` reads `workload`, `score` reads `severity`, and `recommend` reads
// four. Grown one file at a time, so every step keeps 1143 tests green.
@Module({
  providers: [CostUtils, SafetyUtils],
  exports: [CostUtils, SafetyUtils],
})
export class AnalysisModule {}

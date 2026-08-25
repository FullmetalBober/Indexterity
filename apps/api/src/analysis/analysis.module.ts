import { Module } from "@nestjs/common";

// The analysis half (#354).
//
// No providers, deliberately, and this is the decision #354 was corrected to make.
// These are 66 pure functions over their arguments — no pool, no socket, no clock —
// and dependency injection pays for substitutability, lifecycle and interception.
// A function with nothing to substitute gets none of the three.
//
// It was tried the other way first. Every test became `new XUtils()` followed by a
// method call, which is calling the function with extra steps, and the conversion
// cost type inference: a callback that inferred its parameter from a module-scope
// generic function stops inferring once that function is reached through `this.`,
// which produced implicit `any` in the directory whose pure-function property the
// drop pipeline's safety rests on. That work was reverted.
//
// So the module is the unit and the functions stay functions.
@Module({})
export class AnalysisModule {}

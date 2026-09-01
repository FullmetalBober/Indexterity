import { describe, expectTypeOf, it } from "vitest";
import type { Membership } from "./auth/tenancy";
import { BURST_SCHEDULE } from "./jobs/schedule";
import type { TaskName } from "./jobs/tasks";
import type { MssqlReader } from "./mssql/connection";
import type { MssqlUsageMember } from "./mssql/members";
import type { AuthLevel, RouteScope } from "./orpc/implement";

// What the ban left behind that only the type system can be asked about.
//
// Each of these was true because I had read the code and said so. A comment
// saying "an owner-level route gets a resolved membership" is exactly the kind
// of claim `as` used to make — stated, unchecked, and silently wrong the moment
// someone edits the conditional it rests on. `vitest --typecheck` runs these.

describe("the route scope a level produces", () => {
  // The whole point of replacing `scope as RouteScope<L>` with a record keyed by
  // the level. A session caller may be in no organization; the other three
  // cannot be, and a handler reads `context.member.orgId` without checking.
  it("gives an owner a membership that cannot be null", () => {
    expectTypeOf<RouteScope<"owner">["member"]>().toEqualTypeOf<Membership>();
    expectTypeOf<RouteScope<"freshOwner">["member"]>().toEqualTypeOf<Membership>();
    expectTypeOf<RouteScope<"member">["member"]>().toEqualTypeOf<Membership>();
  });

  it("leaves a session caller's membership nullable, because being in none is a state", () => {
    expectTypeOf<RouteScope<"session">["member"]>().toEqualTypeOf<Membership | null>();
  });

  it("has a scope for every level, so a new one cannot be added unnoticed", () => {
    expectTypeOf<AuthLevel>().toEqualTypeOf<"session" | "member" | "owner" | "freshOwner">();
  });
});

describe("the burst schedule", () => {
  // `satisfies` rather than an annotation is what keeps this literal. With the
  // annotation it was `string[]`, and a typo in a task name compiled.
  it("keeps its task names as names, not as strings", () => {
    // Every scheduled pass names a task the registry actually handles…
    expectTypeOf<(typeof BURST_SCHEDULE)[number]["task"]>().toExtend<TaskName>();
    // …and has not widened back to `string`, which is the regression: with the
    // annotation this list carried, a typo compiled and enqueued a job nothing
    // handles. Deliberately not pinned to the seven names it holds today —
    // adding a pass is a normal change, widening the type is not.
    expectTypeOf<(typeof BURST_SCHEDULE)[number]["task"]>().not.toEqualTypeOf<string>();
    expectTypeOf(BURST_SCHEDULE.map((pass) => pass.task)).not.toEqualTypeOf<string[]>();
    // And the literals survived the checking, which is the difference between
    // `satisfies` and an annotation: an annotation flattens every entry to the
    // interface's type, so this list would read as all thirteen task names
    // rather than the seven it schedules. Verified by reverting the `satisfies`
    // and watching it fail.
    expectTypeOf(BURST_SCHEDULE.map((pass) => pass.task)).not.toEqualTypeOf<TaskName[]>();
  });
});

describe("the ports that replaced the fakes", () => {
  // Parameterised on the ROW rather than generic on the method, which is the
  // whole reason a double can answer with data instead of asserting it into
  // shape: the only value assignable to `T[]` for every `T` is `[]`.
  it("fixes a reader's row instead of promising rows of any type", () => {
    expectTypeOf<MssqlReader<{ name: string }>["query"]>().returns.resolves.toEqualTypeOf<
      { name: string }[]
    >();
  });

  // A borrower must not be able to close a connection the roster dialled.
  it("gives a collector no way to close a member it borrowed", () => {
    expectTypeOf<MssqlUsageMember>().not.toHaveProperty("close");
  });
});

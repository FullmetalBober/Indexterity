import type * as contract from "@repo/contracts";
import { describe, expectTypeOf, it } from "vitest";
import type { Membership } from "./auth/tenancy";
import type * as ports from "./engine/ports";
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

// Structural equality modulo `readonly`, which the two spellings below differ in
// deliberately: the ports carry readonly domain types and the contract's output
// schemas want plain ones, so http/mappers.ts copies at the boundary. What must
// NOT differ is the member names and their value types.
type Mutable<T> = T extends readonly (infer E)[]
  ? Mutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

describe("the shapes that exist twice", () => {
  // Four types are spelled once as a zod schema in @repo/contracts and once as an
  // interface in engine/ports.ts, and the duplication is the layering working:
  // the adapters must not depend on the wire format, and the browser cannot
  // import an adapter. What was NOT working is that nothing held the pairs
  // together — a comment on db/schema.ts's `pgEnum` said "must match
  // ClusterEngine in src/engine/ports.ts" and that comment was the entire
  // mechanism.
  //
  // `EngineCapabilities.hideIndexes` already had this problem AND already had
  // the answer: engine/registry.test.ts compares contracts' table against every
  // adapter's own capability, with a comment saying this is exactly the kind of
  // pair that drifts silently. These are the other four pairs, held the same way.
  //
  // Drift in one direction was already caught: add a field to a contract schema
  // and http/mappers.ts stops compiling. The other direction is the silent one —
  // add a field to a port and oRPC's output validation strips it on the way out,
  // so the dashboard simply never sees it.

  it("spells the engine list the same in the contract and the ports", () => {
    expectTypeOf<ports.ClusterEngine>().toEqualTypeOf<contract.ClusterEngine>();
  });

  it("spells the privilege tiers the same", () => {
    expectTypeOf<ports.PrivilegeTier>().toEqualTypeOf<contract.PrivilegeTier>();
  });

  it("agrees on which TLS checks a cluster can turn off", () => {
    expectTypeOf<Mutable<ports.TlsOverrides>>().toEqualTypeOf<contract.TlsOverrides>();
  });

  it("agrees on what a privilege check carries", () => {
    expectTypeOf<Mutable<ports.PrivilegeCheck>>().toEqualTypeOf<contract.PrivilegeCheck>();
  });

  // `engine` is on the contract and not on the port on purpose: the adapters
  // answer about the CONNECTION, and which adapter was asked is the caller's
  // decision, so toDiagnosis() adds it at the boundary (#239). Every other field
  // has to match.
  it("agrees on what a connection diagnosis carries, apart from the engine", () => {
    expectTypeOf<Mutable<ports.ConnectionDiagnosis>>().toEqualTypeOf<
      Omit<contract.ConnectionDiagnosis, "engine">
    >();
  });
});

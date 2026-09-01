import { MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { isAuthorizationError } from "./errors";

// The predicate two call sites route on, tested directly and with no fake.
//
// It had no test of its own. What it had was a collector test that faked
// MongoConnection -> Db -> ListCollectionsCursor so a `toArray()` could reject,
// to watch the classification happen three layers away — a duplicate of what
// mongo.int.test.ts already asserts against a real locked database, bought with
// the last vendor-typed fakes in the suite.
//
// A MongoServerError is constructible, so none of that was ever needed.
describe("isAuthorizationError", () => {
  // Measured on 7.0 against a user with readWrite on one database of two.
  it("recognises code 13", () => {
    expect(
      isAuthorizationError(
        new MongoServerError({
          message: "not authorized on other to execute command { listCollections: 1 }",
          code: 13,
          codeName: "Unauthorized",
        }),
      ),
    ).toBe(true);
  });

  // Atlas and mongos wrap the same refusal with their own numbering, which is
  // why the message is matched as well as the code.
  it("recognises the wording when the code has been renumbered", () => {
    expect(
      isAuthorizationError(new MongoServerError({ message: "not authorized on db", code: 8000 })),
    ).toBe(true);
    expect(
      isAuthorizationError(
        new MongoServerError({ message: "requires authentication", code: 13435 }),
      ),
    ).toBe(true);
  });

  // The half that matters as much: an ordinary failure must NOT be read as a
  // permission refusal, or an unreachable cluster reports as a locked database.
  it("leaves an ordinary server error alone", () => {
    expect(
      isAuthorizationError(new MongoServerError({ message: "connection 3 closed", code: 6 })),
    ).toBe(false);
    expect(isAuthorizationError(new Error("not authorized on other"))).toBe(false);
    expect(isAuthorizationError(undefined)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { watchKey } from "./watched";

describe("watchKey", () => {
  it("scopes an index to its collection", () => {
    expect(watchKey("shop", "orders", "x_1")).toBe("shop\u0000orders\u0000x_1");
    // Same index name in two collections must not collide.
    expect(watchKey("shop", "orders", "x_1")).not.toBe(watchKey("shop", "carts", "x_1"));
  });

  it("does not collide when a name contains the separator's plain-text twin", () => {
    expect(watchKey("a b", "c", "d")).not.toBe(watchKey("a", "b c", "d"));
  });
});

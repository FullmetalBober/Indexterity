import { describe, expect, it } from "vitest";
import { newNonce } from "./nonce";

describe("newNonce", () => {
  // The length is the security property: a nonce an attacker can guess is a
  // nonce they can put on their own script tag.
  it("is 128 bits of base64", () => {
    expect(Buffer.from(newNonce(), "base64")).toHaveLength(16);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 64 }, () => newNonce()));
    expect(seen.size).toBe(64);
  });
});

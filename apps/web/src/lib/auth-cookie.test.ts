import { describe, expect, it } from "vitest";
import { decodeOnce } from "./auth";

// The api percent-encodes the cookie value; the web server's setCookie encodes
// whatever it is handed. Relaying the raw value therefore ships a
// double-encoded signature, the browser sends it back with an extra layer, and
// every request after signing in is a 401 — the app looked signed in and then
// behaved as if it were not.
//
// The property that matters: decode-then-encode must reproduce byte for byte
// what the api sent.
function roundTrip(apiValue: string): string {
  return encodeURIComponent(decodeOnce(apiValue));
}

describe("session cookie relay", () => {
  // Base64 signatures contain "/", "+" and "=" constantly, which is why this
  // was not an edge case but the normal path.
  it("survives a base64 signature unchanged", () => {
    const sent =
      "FJGYHa0AsQH8oc0cbgTQoZMMvBfusdXV.VSH9GNG2t1u%2BCNWrV2Q5U8FbF1QHdQG8oytbaY1lyTs%3D";
    expect(roundTrip(sent)).toBe(sent);
  });

  it("does not add a second layer of escaping", () => {
    expect(roundTrip("a%2Fb")).not.toContain("%252F");
    expect(decodeOnce("a%2Fb")).toBe("a/b");
  });

  it("leaves a value with nothing to decode alone", () => {
    expect(roundTrip("plain-token-value")).toBe("plain-token-value");
  });

  // A value the api did not encode as we expect must not take the cookie down
  // with it — a throw here would lose the session entirely.
  it("passes a malformed escape through rather than throwing", () => {
    expect(decodeOnce("100%-broken")).toBe("100%-broken");
  });
});

import { describe, expect, it } from "vitest";
import { routeTree } from "~/routeTree.gen";
import { normalizePathname, routeLabeller, routePatterns } from "./routes";

// Against the REAL generated tree, on purpose. The walk reads properties off
// route objects, so this is the test that fails if their shape changes — the
// alternative is every request being labelled "unmatched" and nobody noticing,
// because a metric that is silently wrong looks exactly like a metric.
describe("route patterns from the generated tree", () => {
  const patterns = routePatterns(routeTree);

  it("finds every page the app declares", () => {
    expect([...patterns].sort()).toEqual(["/", "/app", "/app/org", "/reset-password"]);
  });

  // An index route's path is "/", which belongs to its parent rather than adding
  // a segment: /app/ and /app are one page.
  it("does not invent a trailing-slash route for an index child", () => {
    expect(patterns.has("/app/")).toBe(false);
  });
});

describe("labelling a request path", () => {
  const label = routeLabeller(routeTree);

  it("labels a declared route with its own pattern", () => {
    expect(label("/app")).toBe("/app");
    expect(label("/app/org")).toBe("/app/org");
    expect(label("/")).toBe("/");
  });

  it("treats a trailing slash as the same route", () => {
    expect(label("/app/")).toBe("/app");
    expect(normalizePathname("/")).toBe("/");
  });

  // The whole point: a scanner must not be able to grow the scrape.
  it("buckets anything the router does not declare", () => {
    for (const path of ["/wp-login.php", "/.env", "/app/nope", "/app/org/extra"]) {
      expect(label(path)).toBe("unmatched");
    }
  });
});

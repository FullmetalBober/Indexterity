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
    expect([...patterns].sort()).toEqual([
      "/",
      "/app",
      "/app/clusters/$clusterId",
      "/app/clusters/$clusterId/settings",
      "/app/clusters/new",
      "/app/settings",
      "/app/settings/account",
      "/app/settings/organizations",
      "/reset-password",
    ]);
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
    expect(label("/app/settings")).toBe("/app/settings");
    expect(label("/")).toBe("/");
  });

  // The point of a pattern label, and the reason a cluster becoming a route did
  // not have to cost this metric: a thousand clusters are one series.
  it("labels every cluster as the same route", () => {
    expect(label("/app/clusters/018f2b1e-0000-7000-8000-000000000001")).toBe(
      "/app/clusters/$clusterId",
    );
    expect(label("/app/clusters/018f2b1e-0000-7000-8000-000000000002")).toBe(
      "/app/clusters/$clusterId",
    );
    expect(label("/app/clusters/anything/settings")).toBe("/app/clusters/$clusterId/settings");
  });

  // Both patterns match this path and only one of them answered it. A static
  // segment wins, or connecting a cluster would be counted as visiting one
  // called "new".
  it("prefers a static route over a dynamic one that also matches", () => {
    expect(label("/app/clusters/new")).toBe("/app/clusters/new");
  });

  it("treats a trailing slash as the same route", () => {
    expect(label("/app/")).toBe("/app");
    expect(normalizePathname("/")).toBe("/");
  });

  // The whole point: a scanner must not be able to grow the scrape.
  it("buckets anything the router does not declare", () => {
    for (const path of [
      "/wp-login.php",
      "/.env",
      "/app/nope",
      "/app/settings/extra",
      "/app/clusters/one/two/three",
    ]) {
      expect(label(path)).toBe("unmatched");
    }
  });
});

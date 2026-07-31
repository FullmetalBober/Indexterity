import { contract } from "@repo/contracts";
import { describe, expect, it } from "vitest";

interface RouteInfo {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

function routes(): RouteInfo[] {
  const found: RouteInfo[] = [];
  for (const [name, procedure] of Object.entries(contract)) {
    const meta: unknown = Reflect.get(procedure, "~orpc");
    if (typeof meta !== "object" || meta === null) continue;
    const route: unknown = Reflect.get(meta, "route");
    if (typeof route !== "object" || route === null) continue;
    const method: unknown = Reflect.get(route, "method");
    const path: unknown = Reflect.get(route, "path");
    if (typeof path !== "string") continue;
    found.push({ name, method: typeof method === "string" ? method : "POST", path });
  }
  return found;
}

describe("contract routes", () => {
  it("exposes routes at all (guards the reflection above)", () => {
    expect(routes().length).toBeGreaterThan(10);
  });

  // The session cookie is SameSite=Lax, which blocks cross-site POST/PATCH/
  // DELETE but still sends the cookie on a top-level GET navigation. So a
  // state-changing GET would be a CSRF hole that nothing else in the stack
  // catches. Read-only naming is the contract; this keeps it one.
  it("has no state-changing GET", () => {
    const readVerbs = /^(list|get)/;
    const offenders = routes()
      .filter((route) => route.method === "GET" && !readVerbs.test(route.name))
      .map((route) => `${route.name} ${route.method} ${route.path}`);
    expect(offenders).toEqual([]);
  });

  it("routes every mutation through a non-GET method", () => {
    const mutations = routes().filter((route) => !/^(list|get)/.test(route.name));
    expect(mutations.length).toBeGreaterThan(5);
    expect(mutations.every((route) => route.method !== "GET")).toBe(true);
  });
});

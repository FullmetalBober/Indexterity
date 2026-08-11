import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contract } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AUTH_LEVELS } from "./implement";

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

// Every `@Implement`ed method must go through `route(…, level)`.
//
// `biome.json` is what actually enforces it — @orpc/nest's `implement` is a
// restricted import, so a handler with no level does not lint. This asserts the
// same thing from the other side, because a lint rule can be switched off in a
// hurry and the failure mode of that is silent: the route keeps working, and it
// works for everybody. Reads the sources rather than reflecting, because the
// level is an argument inside a method body and nothing about it survives to
// runtime.
function controllerSources(): { file: string; text: string }[] {
  // `__dirname`, not `import.meta.dirname`: the api builds to CommonJS, where
  // tsc refuses the meta-property even though vitest would transform it.
  const root = join(__dirname, "..");
  const found: { file: string; text: string }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".controller.ts")) continue;
    const file = join(entry.parentPath, entry.name);
    found.push({ file, text: readFileSync(file, "utf8") });
  }
  return found;
}

describe("every contract route names an authorization level", () => {
  const LEVELS = AUTH_LEVELS.join("|");

  it("finds the controllers at all (guards the walk above)", () => {
    const sources = controllerSources();
    expect(sources.length).toBeGreaterThanOrEqual(7);
    expect(sources.map(({ text }) => text).join("").length).toBeGreaterThan(10_000);
  });

  it("pairs each @Implement with a route(…) that names a level", () => {
    const offenders: string[] = [];
    for (const { file, text } of controllerSources()) {
      // The decorator, then the method, then the builder. Non-greedy up to the
      // next `@Implement` or the end, so one route's level cannot vouch for the
      // route below it.
      for (const match of text.matchAll(
        /@Implement\(contract\.(\w+)\)([\s\S]*?)(?=@Implement\(|$)/g,
      )) {
        const [, name = "", body = ""] = match;
        const gated = new RegExp(
          `route\\(\\s*this\\.tenancy,\\s*contract\\.${name},[^)]*"(${LEVELS})"`,
        );
        if (!gated.test(body)) offenders.push(`${file.split("/src/")[1] ?? file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("covers every route on the contract, so none is implemented elsewhere", () => {
    const implemented = new Set<string>();
    for (const { text } of controllerSources()) {
      for (const match of text.matchAll(/@Implement\(contract\.(\w+)\)/g)) {
        implemented.add(match[1] ?? "");
      }
    }
    const missing = routes()
      .map((route) => route.name)
      .filter((name) => !implemented.has(name));
    expect(missing).toEqual([]);
  });
});

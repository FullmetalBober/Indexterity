import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentCsp, EDGE_HEADERS, newNonce, withSecurityHeaders } from "./security-headers";

function html(): Response {
  return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
}

describe("withSecurityHeaders", () => {
  it.each([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["cross-origin-resource-policy", "same-origin"],
    ["cross-origin-opener-policy", "same-origin"],
  ])("sets %s", (name, value) => {
    expect(withSecurityHeaders(html()).headers.get(name)).toBe(value);
  });

  // The static handler answers assets and public/ before the entry that calls
  // withSecurityHeaders, so these are the ones vite.config.ts has to repeat
  // through routeRules. If one moves out of EDGE_HEADERS it silently stops
  // reaching /favicon.svg, which is how it was missing in the first place.
  it("puts the headers every response needs where nitro can reach them", () => {
    expect(Object.keys(EDGE_HEADERS).sort()).toEqual([
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "permissions-policy",
      "x-content-type-options",
    ]);
  });

  // require-corp buys cross-origin isolation this app does not want and makes
  // the first external avatar anyone adds fail silently.
  it("does not set an embedder policy", () => {
    expect(withSecurityHeaders(html()).headers.has("cross-origin-embedder-policy")).toBe(false);
  });

  it("names the features this app does not use", () => {
    const policy = withSecurityHeaders(html()).headers.get("permissions-policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  // The policy is per response and comes from src/server.ts, which is the only
  // place holding both the router the nonce has to reach and the headers it has
  // to be named in. This function must not write a second one over it — two
  // policies on one response are INTERSECTED by the browser, so a constant added
  // here would silently subtract from the real one.
  it("leaves the per-response content-security-policy alone", () => {
    const response = new Response("", {
      headers: { "content-security-policy": "script-src 'nonce-abc'" },
    });
    expect(withSecurityHeaders(response).headers.get("content-security-policy")).toBe(
      "script-src 'nonce-abc'",
    );
  });

  it("writes no content-security-policy of its own", () => {
    expect(withSecurityHeaders(html()).headers.has("content-security-policy")).toBe(false);
  });
});

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

describe("documentCsp", () => {
  const policy = documentCsp("NONCE");
  const directive = (name: string): string =>
    new RegExp(`(?:^|; )${name} ([^;]*)`).exec(policy)?.[1] ?? "";

  it("starts from a default that refuses", () => {
    expect(directive("default-src")).toBe("'none'");
  });

  it("allows the response's own scripts and nothing inline besides", () => {
    expect(directive("script-src")).toBe("'self' 'nonce-NONCE'");
  });

  // 'unsafe-inline' beside a nonce is ignored by a browser that understands the
  // nonce and honoured by one that does not, which makes it a hole shaped like a
  // fallback. 'strict-dynamic' would make 'self' ignored, and the
  // `<link rel=modulepreload>` tags carry no nonce to inherit trust from.
  it.each(["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "*"])(
    "does not weaken script-src with %s",
    (token) => {
      expect(directive("script-src")).not.toContain(token);
    },
  );

  // Style ELEMENTS are allowed by name — the nonce for what asks `get-nonce` for
  // one, the hashes for sonner, which does not. 'unsafe-inline' would be the
  // easy answer and is the one thing this must not say, since it is also what
  // ZAP reports as 10055.
  it("allows style elements by name, never by 'unsafe-inline'", () => {
    expect(directive("style-src")).not.toContain("'unsafe-inline'");
    expect(directive("style-src")).toContain("'nonce-NONCE'");
    expect(directive("style-src")).toContain("'sha256-");
  });

  // The one environment difference, and it belongs to the dev SERVER rather than
  // to this app: `@vite/client` applies the stylesheet by creating a style
  // element, and the meta tag it looks for a nonce in is written by TanStack
  // Start with the value in `content` rather than in `nonce`. Without this the
  // whole dashboard renders unstyled under `npm run dev`.
  describe("under the vite dev server", () => {
    const devPolicy = documentCsp("NONCE", { dev: true });
    const devDirective = (name: string): string =>
      new RegExp(`(?:^|; )${name} ([^;]*)`).exec(devPolicy)?.[1] ?? "";

    // Dropping the nonce and the hashes is the point, not an oversight: a
    // browser IGNORES 'unsafe-inline' in a directive that carries either, so
    // appending it would have changed nothing — which it duly did, until this
    // was measured against a running dev server.
    it("permits the dev server's injected stylesheet", () => {
      expect(devDirective("style-src")).toBe("'self' 'unsafe-inline'");
    });

    // The allowance is for style elements and for nothing else. A build is what
    // the e2e suite and the ZAP job read, so this is the only place a difference
    // could hide.
    it("changes nothing else", () => {
      const rest = (from: string): string[] =>
        from.split("; ").filter((part) => !part.startsWith("style-src "));
      expect(rest(devPolicy)).toEqual(rest(policy));
    });
  });

  // The attribute is a separate directive and the one place 'unsafe-inline' is
  // unavoidable: React server-renders `style={{…}}` as `style="…"`. Stated
  // separately so that widening it never widens style-src by accident.
  it("permits style attributes, and only attributes", () => {
    expect(directive("style-src-attr")).toBe("'unsafe-inline'");
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
  });

  // The hashes in the policy are constants of the INSTALLED dependencies, and
  // this recomputes them from node_modules. An upgrade that changes one byte of
  // either stylesheet is then a red unit test naming the constant to update —
  // not a toast that quietly loses its styling in production.
  //
  // `resolve` rather than a path, because npm may hoist these to the repo root
  // or keep them here.
  const require_ = createRequire(join(process.cwd(), "package.json"));
  const hashOf = (css: string): string =>
    `'sha256-${createHash("sha256").update(css).digest("base64")}'`;

  it("carries the hash of the sonner stylesheet actually installed", () => {
    // Either of sonner's builds serves: vite bundles the ESM one, `resolve`
    // finds the CJS one, and the CSS literal is byte-identical in both.
    const source = readFileSync(require_.resolve("sonner"), "utf8");
    const literal = /__insertCSS\("(.*?)"\);?\n/s.exec(source)?.[1];
    expect(literal, "sonner no longer injects its CSS from one __insertCSS call").toBeTruthy();
    expect(
      directive("style-src"),
      "sonner's stylesheet changed — update INJECTED_STYLE_HASHES",
    ).toContain(hashOf(JSON.parse(`"${literal}"`) as string));
  });

  it("carries the hash of the radix select viewport rule actually installed", () => {
    const source = readFileSync(require_.resolve("@radix-ui/react-select"), "utf8");
    const literal = /__html: `(\[data-radix-select-viewport\][^`]*)`/.exec(source)?.[1];
    expect(literal, "radix select no longer renders one viewport style").toBeTruthy();
    expect(
      directive("style-src"),
      "the radix select viewport rule changed — update INJECTED_STYLE_HASHES",
    ).toContain(hashOf(literal ?? ""));
  });

  // Not a third dependency: a browser checks a style element when it is appended
  // and again when its text lands, and the first check sees an empty one.
  it("allows the empty style element every injection is checked as first", () => {
    expect(directive("style-src")).toContain(hashOf(""));
  });

  // Same-origin is the whole of it because the web server answers /api itself,
  // and the browser bundle contains no Sentry to dial an ingest host.
  it("keeps every fetch on this origin", () => {
    expect(directive("connect-src")).toBe("'self'");
  });

  it.each([
    ["frame-ancestors", "'none'"],
    ["base-uri", "'none'"],
    ["object-src", "'none'"],
    ["form-action", "'self'"],
    ["font-src", "'self'"],
    ["img-src", "'self' data:"],
  ])("sets %s to %s", (name, value) => {
    expect(directive(name)).toBe(value);
  });

  // Everything this handler answers is a document rendered from a tenant's data
  // or a server function returning it. The content-hashed assets — the only
  // cacheable thing on this origin — are answered by nitro's static handler and
  // get their year from routeRules in vite.config.ts, not from here.
  it("refuses to store what it answers", () => {
    expect(withSecurityHeaders(html()).headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("leaves a header the route already set", () => {
    const response = new Response("", { headers: { "referrer-policy": "no-referrer" } });
    expect(withSecurityHeaders(response).headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("leaves a cache-control the route already set", () => {
    const response = new Response("", { headers: { "cache-control": "public, max-age=60" } });
    expect(withSecurityHeaders(response).headers.get("cache-control")).toBe("public, max-age=60");
  });
});

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// What the dashboard server's environment must be, and the boundary between what
// the server may read and what the browser may.
//
// t3-env rather than a second hand-rolled schema, because the SPLIT is the
// interesting part here. api-origin.ts and api-passthrough.ts read process.env
// in modules that sit in the SSR graph; nothing structural stopped one of those
// values being read from a module the client build also pulls in, and a runtime
// address inlined into the bundle is what broke compose in #2. Every variable
// below is `server`, so reading one in the browser throws by construction rather
// than quietly returning undefined. A value the browser genuinely needs has to
// be declared under `client` with the VITE_ prefix, which is public by
// definition — and today there are none, which is the point.
//
// Same rule as the api's schema (apps/api/src/config/schema.ts): **absent is
// fine, malformed is fatal.**

// Fastify's trustProxy dialect: "true", "false", a hop count, or a CIDR list.
//
// The web server only needs the yes/no — whether something in front is known to
// set x-forwarded-for, which decides whether the passthrough may forward the
// client's own copy of it. But it must read the WHOLE dialect, because the chart
// hands this pod the same value it hands the api, and that is usually a CIDR
// list. Comparing against "true" read a configured proxy as "no proxy" and
// stripped the header the api's rate limits are counted by.
const CIDR = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;

export function isTrustProxyValue(raw: string): boolean {
  const value = raw.trim();
  if (value === "true" || value === "false") return true;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0) return true;
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.every((entry) => CIDR.test(entry) && /[.:]/.test(entry));
}

// Whether the value names something in front. Pure over its argument so the
// dialect can be stated in a test without a server.
export function proxyTrustedBy(raw: string): boolean {
  return raw.trim() !== "false" && raw.trim() !== "";
}

export const env = createEnv({
  server: {
    NODE_ENV: z.string().default("development"),
    // Where the api is, from THIS server's side of the network. Read at runtime
    // so one image deploys to every environment.
    API_URL: z.url().default("http://localhost:3001"),
    // The port nitro listens on in the built image. `vite dev` takes its own
    // from vite.config.ts and never reads this.
    PORT: z.coerce.number().int().positive().default(3000),
    TRUST_PROXY: z.string().trim().default("false").refine(isTrustProxyValue, {
      message:
        'expected "true", "false", a hop count ("1"), or a comma-separated CIDR list ("10.0.0.0/8")',
    }),
    // Overrides the canonical URL in the landing page's SEO tags. Left unset
    // outside a fork or a separately-indexed staging copy.
    SITE_URL: z.url().optional(),
    METRICS_ENABLED: z.enum(["true", "false"]).default("false"),
    METRICS_PORT: z.coerce.number().int().positive().default(9464),
    SENTRY_DSN: z.url().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
  },
  // No client variables, deliberately. The browser calls /api on the origin it
  // loaded the page from and needs no address of its own; the prefix is declared
  // so that adding one is a decision rather than an accident.
  clientPrefix: "VITE_",
  client: {},
  // Guarded because the client build has no `process`: t3-env skips validating
  // server variables in the browser, but this expression is still evaluated.
  runtimeEnv: typeof process === "undefined" ? {} : process.env,
  // Compose and Helm both render an unset value as "", so telling it apart from
  // absent would make every optional variable mandatory on the stacks this repo
  // ships.
  emptyStringAsUndefined: true,
});

// Whether something in front of this server is trusted to have set the
// forwarded-address headers.
export function trustsProxy(): boolean {
  return proxyTrustedBy(env.TRUST_PROXY);
}

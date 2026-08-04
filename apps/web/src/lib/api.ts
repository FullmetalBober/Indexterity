import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { contract } from "@repo/contracts";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

// One client, called from both sides. A route loader uses it during SSR and the
// same query function uses it in the browser afterwards, which is the whole
// reason the three pieces below are isomorphic rather than one module for each
// side: the caller must not have to know where it is running.

// Where the api is, from wherever the caller happens to be.
//
// In the browser it is THIS origin. Every deployment puts the api under /api on
// the dashboard's host — the ingress does it in Kubernetes, nginx in compose —
// so the session cookie is first-party and rides along by itself. The api's
// real address stays out of the bundle, which is what runtime API_URL used to
// buy and now costs nothing.
//
// On the web server that origin is not the api: it dials the api directly, at
// API_URL, still read at RUNTIME so one image deploys to every environment.
// There is deliberately no VITE_API_URL fallback any more. A build-time default
// for a value only the server reads is what broke compose in #2 — the web
// server fell back to the browser-facing address and dialled itself.
const apiBaseUrl = createIsomorphicFn()
  .client(() => `${window.location.origin}/api`)
  .server(() => `${process.env.API_URL ?? "http://localhost:3001"}/api`);

// Only the web server has to say who is asking. It is answering on behalf of a
// browser, so it forwards that request's cookie; in the browser the cookie is
// the browser's own and a same-origin fetch attaches it without being asked.
const sessionHeaders = createIsomorphicFn()
  .client((): Record<string, string> => ({}))
  .server(
    (): Record<string, string> => ({
      cookie: getRequest()?.headers.get("cookie") ?? "",
    }),
  );

// Times and counts the call, on the web server only.
//
// lib/metrics is server-only by construction — importing it installs an
// OpenTelemetry provider — so it is imported INSIDE this branch rather than at
// the top of the file. The client build replaces the whole branch with the one
// above, and the import goes with it, instead of being left in the module for
// tree-shaking to prove unreachable against a provider that has side effects at
// import time.
//
// Browser calls are no longer measured here, and cannot be: they do not pass
// through the dashboard server at all any more. The api counts them.
const callApi = createIsomorphicFn()
  .client((request: Request, _path: readonly string[]) => globalThis.fetch(request))
  .server(async (request: Request, path: readonly string[]) => {
    const { instrumentedFetch } = await import("~/lib/metrics/upstream");
    return instrumentedFetch(path, request);
  });

// Calls return data directly and THROW ORPCError on 4xx/5xx. What that means is
// the query layer's decision, not this module's: an empty panel for a read, the
// api's own words in a toast for a mutation (see lib/queries/errors.ts).
export function api(): JsonifiedClient<ContractRouterClient<typeof contract>> {
  const link = new OpenAPILink(contract, {
    url: apiBaseUrl,
    headers: sessionHeaders,
    fetch: (request, _init, _options, path) => callApi(request, path),
  });
  return createORPCClient(link);
}

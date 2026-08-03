import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { contract } from "@repo/contracts";
import { getRequest } from "@tanstack/react-start/server";

// serverApi() only ever runs on the web server, so API_URL can be read at
// RUNTIME — one image deploys to every environment (the Helm chart points it
// at the api Service). VITE_API_URL stays the build-time default.
function apiBaseUrl(): string {
  const runtime = typeof process === "undefined" ? undefined : process.env.API_URL;
  return runtime ?? import.meta.env.VITE_API_URL ?? "http://localhost:3001";
}

// oRPC client over the OpenAPI link, forwarding the caller's session cookie to
// the api. Call only inside server functions — it reads the request context.
// Calls return data directly and THROW ORPCError on 4xx/5xx (wrap with safe()
// or try/catch at the call site).
export function serverApi(): JsonifiedClient<ContractRouterClient<typeof contract>> {
  const cookie = getRequest()?.headers.get("cookie") ?? "";
  const link = new OpenAPILink(contract, {
    url: `${apiBaseUrl()}/api`,
    headers: () => ({ cookie }),
  });
  return createORPCClient(link);
}

import type { IncomingHttpHeaders } from "node:http";

// Fastify's parsed headers -> a web Headers, so better-auth can read the session
// cookie from a Nest/Fastify request.
export function toWebHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }
  return headers;
}

// Where the api is, from the web server's side of the network.
//
// Read at RUNTIME so one image deploys to every environment. Deliberately no
// VITE_ fallback: a build-time default for a value only the server reads is
// what broke compose in #2, when the web server took the browser-facing address
// and dialled itself.
//
// Server-only, and its own module so that stays true. The browser has no
// process.env and does not need this — it calls /api on its own origin. Both
// callers here (the SSR branch of lib/api.ts, and the passthrough) are deleted
// from the client build, so this is tree-shaken out with them; the build check
// in CI is what keeps that honest.
export function apiOrigin(): string {
  return process.env.API_URL ?? "http://localhost:3001";
}

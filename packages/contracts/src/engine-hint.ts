import type { ClusterEngine } from "./schemas.js";

// Which engine a pasted string LOOKS like, cheaply, in the browser.
//
// A hint, and the distinction is the whole reason this file is separate from the
// api's `detectEngine`: that one asks each adapter's real guard, which parses the
// string (mongodb-connection-string-url for one, the ADO/URI reader for the
// other) and is the only thing that decides what a connect actually does. This
// one reads the SCHEME and nothing else, because the dashboard needs an answer
// on every keystroke and cannot ship either parser to do it.
//
// What it is allowed to be used for, therefore: choosing wording, drawing a
// badge, and deciding whether to offer the engine override — all things a wrong
// guess makes cosmetic. What it must never be used for is refusing a string or
// deciding which adapter runs; the api answers both, and it answers again with
// the whole string in hand.
//
// The two are held to each other by a test in the api (`engine/registry.test.ts`)
// that runs both over one corpus of strings, because this is exactly the kind of
// pair that drifts silently: a scheme added to an adapter and not here shows the
// wrong badge for a release before anybody notices.
const SCHEMES: readonly { readonly engine: ClusterEngine; readonly test: RegExp }[] = [
  { engine: "MONGODB", test: /^\s*mongodb(\+srv)?:\/\//i },
  // Two dialects, and the ADO one has no scheme at all — `Server=host;User
  // Id=…` is a semicolon list, which is why this cannot be a startsWith on a
  // protocol. Anchored to the first key so a mongo string carrying `server=` in
  // a query parameter cannot claim it.
  { engine: "MSSQL", test: /^\s*(mssql|sqlserver):\/\//i },
  { engine: "MSSQL", test: /^\s*(server|data source)\s*=/i },
];

export function engineFromScheme(connectionString: string): ClusterEngine | null {
  for (const { engine, test } of SCHEMES) {
    if (test.test(connectionString)) return engine;
  }
  return null;
}

// Who ran the query?
//
// `$queryStats` groups by client as well as by shape, so the same `find` issued
// from a shell and from an application server are already separate entries —
// each carrying the connecting client's application and driver name. That is a
// far sharper signal than counting executions: "seen three times" cannot tell a
// developer paging through data from a request path that runs every second.
//
// An index built for someone's afternoon of exploring is pure cost: it is
// maintained on every write forever, for queries that will never run again.

// Interactive tools: a person is typing. Matched loosely on purpose — every one
// of these ships variants and version suffixes ("mongosh 2.8.3", "MongoDB
// Compass 1.42"), and a new GUI appearing is far more likely than an
// application driver naming itself after one.
const INTERACTIVE = [
  "mongosh",
  "mongo shell",
  "compass",
  "studio 3t",
  "robo 3t",
  "robomongo",
  "nosqlbooster",
  "datagrip",
  "dbeaver",
  "tableplus",
  "mongodb for vs code",
  "mongo-express",
  "mongocli",
  "atlas cli",
];

function looksInteractive(name: string): boolean {
  const lower = name.toLowerCase();
  return INTERACTIVE.some((tool) => lower.includes(tool));
}

// One client as the workload source describes it.
export interface QueryClient {
  // From the connection string's appName, or the driver's default.
  readonly application?: string;
  readonly driver?: string;
}

export type ClientKind = "INTERACTIVE" | "APPLICATION" | "UNKNOWN";

export function classifyClient(client: QueryClient): ClientKind {
  const application = client.application ?? "";
  const driver = client.driver ?? "";
  if (application === "" && driver === "") return "UNKNOWN";
  // The shell reports itself in BOTH fields ("nodejs|mongosh"), and a
  // hand-set appName is the more specific claim, so either matching is enough.
  if (looksInteractive(application) || looksInteractive(driver)) return "INTERACTIVE";
  return "APPLICATION";
}

// Should this shape earn an index?
//
// Only if something other than a person at a prompt ran it. A shape seen solely
// from shells and GUIs is someone exploring; the index would outlive the
// curiosity by years. UNKNOWN counts as application traffic — a client that
// never named itself leaves no evidence either way, and refusing to act on
// missing evidence would silently disable workload analysis for those shapes.
export function isWorthIndexing(clients: readonly QueryClient[]): boolean {
  if (clients.length === 0) return true;
  return clients.some((client) => classifyClient(client) !== "INTERACTIVE");
}

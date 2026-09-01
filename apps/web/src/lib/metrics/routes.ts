// Which pathnames may become a metric label.
//
// The route PATTERN, never the raw path. A counter labelled with whatever arrived
// mints one series per URL, so a scanner walking /wp-login.php, /.env and a
// thousand others would grow the scrape until it outgrew the process. Only paths
// the router actually declares are labels; everything else is "unmatched".
//
// Derived from the generated route tree rather than a hand-kept list, so a route
// added tomorrow is labelled without anyone remembering to come back here. The
// walk reads two properties off each route, which is why routes.test.ts asserts
// the result against the real tree: if the shape ever changes, that fails rather
// than every label quietly becoming "unmatched".

interface RouteLike {
  readonly path?: string;
  readonly options?: { readonly path?: string };
  readonly children?: unknown;
}

function pathOf(route: RouteLike): string | undefined {
  return route.path ?? route.options?.path;
}

/**
 * A type guard rather than three assertions.
 *
 * The route tree arrives as `unknown` — it is the router's generated object and
 * this module deliberately does not depend on its types — so every read used to
 * assert a shape onto it. Every field of RouteLike is optional, so the only
 * thing worth checking is that a value is an object at all, and a predicate says
 * exactly that: anything else is skipped rather than walked as if it were a
 * route.
 */
function isRoute(value: unknown): value is RouteLike {
  return typeof value === "object" && value !== null;
}

function childrenOf(route: RouteLike): Array<RouteLike> {
  const children = route.children;
  if (Array.isArray(children)) return children.filter(isRoute);
  if (isRoute(children)) return Object.values(children).filter(isRoute);
  return [];
}

// Join a parent pattern with a child's own segment. An index route's path is "/",
// which contributes nothing to its parent — `/app` + `/` is `/app`, not `/app/`.
function join(parent: string, segment: string): string {
  if (segment === "/" || segment === "") return parent === "" ? "/" : parent;
  const suffix = segment.startsWith("/") ? segment : `/${segment}`;
  return parent === "/" ? suffix : `${parent}${suffix}`;
}

export function routePatterns(tree: unknown): Set<string> {
  const patterns = new Set<string>();
  const walk = (route: RouteLike, parent: string): void => {
    const own = pathOf(route);
    // The root route has no path of its own and contributes the empty prefix.
    const here = own === undefined ? parent : join(parent, own);
    if (own !== undefined) patterns.add(here === "" ? "/" : here);
    for (const child of childrenOf(route)) walk(child, here);
  };
  if (isRoute(tree)) walk(tree, "");
  return patterns;
}

// Trailing slashes are the same route; the router treats them that way and two
// series for one page would be worse than useless.
export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

// A pattern's segments, with `$clusterId` and friends standing for "any one
// segment". The label is still the PATTERN, so the cardinality is the number of
// routes however many clusters exist — which is the whole reason this file
// exists.
function segmentsOf(pattern: string): string[] {
  return pattern.split("/").filter((segment) => segment !== "");
}

function matches(patternSegments: readonly string[], pathSegments: readonly string[]): boolean {
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment.startsWith("$") || segment === pathSegments[index],
  );
}

export function routeLabeller(tree: unknown): (pathname: string) => string {
  const patterns = routePatterns(tree);
  // Static patterns first, so /app/clusters/new is labelled as itself rather
  // than as /app/clusters/$clusterId — both match, and only one is the route
  // that answered.
  const candidates = [...patterns]
    .map((pattern) => ({ pattern, segments: segmentsOf(pattern) }))
    .sort(
      (a, b) =>
        a.segments.filter((segment) => segment.startsWith("$")).length -
        b.segments.filter((segment) => segment.startsWith("$")).length,
    );

  return (pathname) => {
    const normalized = normalizePathname(pathname);
    // Exact first: it is the common case and it is a set lookup.
    if (patterns.has(normalized)) return normalized;
    const pathSegments = segmentsOf(normalized);
    const found = candidates.find((candidate) => matches(candidate.segments, pathSegments));
    return found?.pattern ?? "unmatched";
  };
}

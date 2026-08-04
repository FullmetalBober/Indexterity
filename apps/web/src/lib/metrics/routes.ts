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

function childrenOf(route: RouteLike): Array<RouteLike> {
  const children = route.children;
  if (Array.isArray(children)) return children as Array<RouteLike>;
  if (typeof children === "object" && children !== null) {
    return Object.values(children as Record<string, RouteLike>);
  }
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
  if (typeof tree === "object" && tree !== null) walk(tree as RouteLike, "");
  return patterns;
}

// Trailing slashes are the same route; the router treats them that way and two
// series for one page would be worse than useless.
export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export function routeLabeller(tree: unknown): (pathname: string) => string {
  const patterns = routePatterns(tree);
  return (pathname) => {
    const normalized = normalizePathname(pathname);
    return patterns.has(normalized) ? normalized : "unmatched";
  };
}

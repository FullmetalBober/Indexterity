// A side-effect import, and it has to precede the first Radix dialog rather than
// any particular module — see the file for what it hands over and why it is read
// from the DOM instead of embedded in it.
import "./lib/style-nonce";
import { createRouter, Link } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Skeleton } from "./components/ui/skeleton";
import { createAppQueryClient } from "./lib/queries/client";
import { routeTree } from "./routeTree.gen";

// Friendly fallbacks instead of the framework's developer screens.
function AppError({ error }: { error: Error }) {
  return (
    <main className="mx-auto mt-24 max-w-md p-8 text-center">
      <h1 className="font-semibold text-2xl">Something broke</h1>
      <p className="mt-2 text-muted-foreground text-sm">{error.message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-6 rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm"
      >
        Reload
      </button>
    </main>
  );
}

function NotFound() {
  return (
    <main className="mx-auto mt-24 max-w-md p-8 text-center">
      <h1 className="font-semibold text-2xl">Page not found</h1>
      <p className="mt-2 text-muted-foreground text-sm">Nothing lives at this address.</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm"
      >
        Back to Indexterity
      </Link>
    </main>
  );
}

// Something is on its way and the reader has already been waiting a moment for
// it. Only the loaders that MUST finish before a page can be chosen reach this:
// /app and the cluster layout both read to decide where the reader is going, and
// a page rendered before that decision is a page they did not ask for. Every
// loader that merely warms what a page draws hands over immediately instead and
// lets the panels outline themselves, which is the better shape when it is
// available — this is the fallback for when it is not.
function PendingPage() {
  return (
    <div className="space-y-4 p-8" aria-busy="true">
      {/* The visual skeleton says nothing to a screen reader, and an aria-busy
          region with no text says only that something is busy. */}
      <span className="sr-only">Loading</span>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    </div>
  );
}

export function getRouter() {
  // The one and only place this is constructed. Loaders write through it and
  // the provider reads it back out of context, so server-rendered data and the
  // browser cache are the same entry rather than two that drift apart.
  const queryClient = createAppQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Run a link's loader when the pointer settles on it, so the click lands on
    // data that is already there. The cluster page is the one this is for: its
    // loader fans out seven reads, and until now every one of them started after
    // the click.
    //
    // The cost is reads for a cluster nobody opened, and what bounds it is the
    // query cache rather than this setting — the loaders go through
    // ensureQueryData, so a preload fills the same entries the click would have,
    // and `defaultPreloadStaleTime` below stops a second hover re-asking. Sweeping
    // the pointer down a list of eight clusters is therefore eight loaders once,
    // not once per pass.
    defaultPreload: "intent",
    // 50ms is the framework's default and it is too eager for a list: moving the
    // pointer to the thing you actually want crosses the rows above it, and each
    // of those is a cluster page's worth of reads. 200ms is past the speed a
    // pointer travels over something on its way elsewhere and well under the time
    // it takes to decide to click.
    defaultPreloadDelay: 200,
    // Matches the query client's staleTime (queries/client.ts). Left at the
    // framework's 30s, but stated, because the two numbers have to agree: a
    // preload window shorter than the cache window re-runs loaders that answer
    // from cache anyway, and a longer one serves a click from data this router
    // declined to refresh.
    defaultPreloadStaleTime: 30_000,
    defaultErrorComponent: AppError,
    defaultNotFoundComponent: NotFound,
    // Nothing rendered this until now, and the absence was not a tuning choice:
    // router-core arms the pending timeout only when a pendingComponent or this
    // exists (setupPendingTimeout), so with neither set the pending state never
    // ran at all. A blocking loader showed the reader the page they were
    // leaving, for as long as it took, with no indication their click had landed.
    defaultPendingComponent: PendingPage,
    // 300ms rather than the framework's 1000. A navigation that resolves inside
    // ~300ms reads as instant and is better left alone — swapping the page for
    // an outline and back is a flash that reports a wait nobody had. Past it,
    // silence starts reading as a click that missed.
    //
    // Stated together with defaultPendingMinMs because the pair is what decides
    // the behaviour, and the framework's 500 is the half that surprises: once
    // this component is shown it is held for that long whether or not the data
    // arrives first. So the real cost of lowering the number above is not the
    // extra skeletons, it is that each one commits the reader to 500ms. 300
    // keeps that off the navigations that were never slow.
    defaultPendingMs: 300,
    defaultPendingMinMs: 500,
  });

  // The server's cache is a different object from the browser's, and nothing
  // carries one into the other by default: the router serializes loader RETURN
  // values, and a loader that fills the cache and returns nothing serializes
  // nothing. So the browser used to hydrate against an empty cache — every
  // useQuery started at undefined, the page fell back to its empty shapes for
  // a paint, and every read the server had just done was done again.
  //
  // This dehydrates the cache into the SSR payload and hydrates it back, which
  // is what lets a page read a query instead of loader data. Queries that
  // resolve after the shell is flushed are streamed in as they land.
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    // __root.tsx provides the client, out of router context. Two providers
    // around the same client would also work; one is easier to reason about,
    // and that one is where the comment explaining it lives.
    wrapQueryClient: false,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

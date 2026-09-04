import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "~/components/ui/tooltip";

// A refusal from the api, in the shape the oRPC client delivers one: a throw,
// not a value. It used to arrive as { ok: false, message } because a server
// function sat in between and caught it; nothing does now.
//
// The status is not decoration. The mutation hooks read it to decide whether
// the api's own words are safe to show, so a test that asserts on wording has
// to carry the status that makes those words readable.
export function apiError(status: number, message: string): Error {
  return new ORPCError("TEST_FAILURE", { status, message });
}

// A refusal from better-auth, which delivers one the other way round: every
// call resolves to `{ data, error }` and nothing is ever thrown. Org mutations
// go through its client now, so their tests need the shape its client returns
// rather than the shape oRPC throws.
export function authOk<T>(data: T): { data: T; error: null } {
  return { data, error: null };
}

export function authError(
  status: number,
  message: string,
  code?: string,
): { data: null; error: { status: number; message: string; code?: string } } {
  return { data: null, error: { status, message, ...(code === undefined ? {} : { code }) } };
}

interface AppRender extends RenderResult {
  // Handed back so a test can watch what a mutation invalidates. That used to be
  // observable as a callback prop; now the mutation hooks own the key, and this
  // is what "the right key" is asserted against.
  readonly queryClient: QueryClient;
}

// The providers routes/__root.tsx wraps every page in. A component rendered
// without them throws on its first tooltip or its first useMutation, which is a
// failure about the test harness rather than about the component — so anything
// using one renders through here instead of bare render().
export function renderInApp(ui: ReactElement): AppRender {
  // One client per render, not per module: the app's cache is per tab, and a
  // shared one here would carry a mutation's invalidation from one test into
  // the next. retry off so a rejected server function lands in onError on the
  // first attempt rather than three seconds later.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
      </QueryClientProvider>
    );
  }
  return Object.assign(render(ui, { wrapper: Providers }), { queryClient });
}

// A real QueryClient, or a fake with the one method a loader calls.
interface LoaderContext {
  params: { clusterId: string };
  context: { queryClient: Pick<QueryClient, "ensureQueryData"> };
}

/**
 * Run the loader a route actually registers.
 *
 * Off the route rather than a copy of its body — a copy would keep passing while
 * the real loader grew an await, or warmed a key the component does not read.
 * `route.options.loader` is TanStack's own type, which is not worth restating: a
 * hand-written signature was close enough to compile and not the same function,
 * so calling it took an assertion. Narrowing with `typeof` gives a callable, and
 * the arguments are checked against LoaderContext on the way in, which is the
 * half that matters here.
 */
export async function runLoader(
  route: { options: { loader?: unknown } },
  context: LoaderContext,
): Promise<unknown> {
  const loader = route.options.loader;
  if (typeof loader !== "function") throw new Error("expected a loader");
  return loader(context);
}

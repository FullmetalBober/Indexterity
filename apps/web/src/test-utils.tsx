import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "~/components/ui/tooltip";

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

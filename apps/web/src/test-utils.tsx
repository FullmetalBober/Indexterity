import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { TooltipProvider } from "~/components/ui/tooltip";

// The providers routes/__root.tsx wraps every page in. A component rendered
// without them throws on its first tooltip or its first useMutation, which is a
// failure about the test harness rather than about the component — so anything
// using one renders through here instead of bare render().
function Providers({ children }: { children: ReactNode }) {
  // One client per render, not per module: the app's cache is per tab, and a
  // shared one here would carry a mutation's invalidation from one test into
  // the next. retry off so a rejected server function lands in onError on the
  // first attempt rather than three seconds later.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

export function renderInApp(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: Providers });
}

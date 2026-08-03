import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Toaster } from "~/components/ui/sonner";
import { TooltipProvider } from "~/components/ui/tooltip";
import "../styles.css";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Indexterity" },
      // MongoDB-family primary, matching the dashboard's theme.
      { name: "theme-color", content: "#00684A" },
      // Routes override this: the landing page opts INTO indexing, everything
      // else (dashboard, password reset) stays out of search results.
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  }),
  component: RootComponent,
});

function RootComponent() {
  // Out of context, never from the factory. Constructing a second client here
  // is the bug that made every query suspend against an empty cache while the
  // loaders filled a different one.
  const { queryClient } = Route.useRouteContext();
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <Outlet />
          <Toaster richColors closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

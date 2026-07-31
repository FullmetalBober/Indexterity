import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ToastProvider } from "../components/ui/toast";
import "../styles.css";

export const Route = createRootRoute({
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
  return (
    <RootDocument>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
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

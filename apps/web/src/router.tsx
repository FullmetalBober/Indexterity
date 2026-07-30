import { createRouter, Link } from "@tanstack/react-router";
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

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultErrorComponent: AppError,
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

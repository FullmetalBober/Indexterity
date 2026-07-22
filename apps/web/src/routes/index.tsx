import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">mongo-optimizer</h1>
      <p className="mt-2 text-slate-600">
        Dashboard scaffold. Recommendations, ROI, and cluster health land here.
      </p>
    </main>
  );
}

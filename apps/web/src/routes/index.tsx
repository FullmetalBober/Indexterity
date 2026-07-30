import { createFileRoute, Link } from "@tanstack/react-router";

// Marketing landing at / — fully static (no loader, no api calls), so it
// renders even when the control plane is down. The dashboard lives at /app.
export const Route = createFileRoute("/")({
  component: Landing,
});

const FEATURES = [
  {
    title: "Read-only by default",
    body: "Connect a cluster and Indexterity analyzes forever without touching it. Writes happen only after an owner flips the cluster live — and even then, indexes only, never your documents.",
  },
  {
    title: "A safety pipeline, not a script",
    body: "Drops go hide → observe (30 days by default) → regression gate → pre-flight → drop. Anything that slows reads is un-hidden, remembered, and cooled down. Undo rebuilds a dropped index from its recorded spec.",
  },
  {
    title: "Confidence scores",
    body: "Every recommendation carries a 0–100 score from usage history, redundancy, size and scan frequency. Set an auto-approve threshold, or approve by hand — past regressions cut the score hard either way.",
  },
  {
    title: "Workload-aware creates",
    body: "Query shapes from $queryStats (no profiler needed) or the profiler become Equality → Sort → Range compounds with correct sort directions, partial indexes for constant filters, and TTL advisories for manual age-based cleanups.",
  },
  {
    title: "Proof, not promises",
    body: "Freed bytes and their $/month, index-count deltas, and per-collection read/write latency charts — before and after. New indexes are watched too: if writes regress, the build rolls back automatically.",
  },
  {
    title: "Built for teams",
    body: "Orgs with owner/member roles, email invites, an immutable audit trail of every executed operation, engine alerts by email and a weekly digest of what read-only clusters would have done.",
  },
];

const STEPS = [
  [
    "Connect read-only",
    "Paste a mongodb:// connection string for an index-only user. Credentials are envelope-encrypted at rest.",
  ],
  [
    "Collect & score",
    "Usage, sizes, latency and query shapes on a schedule — every recommendation arrives scored and explained.",
  ],
  [
    "Approve — or set a threshold",
    "Click approve, or let autoApplyScore promote confident recommendations. The observe gates still stand.",
  ],
  [
    "Watch the ROI",
    "Latency trends, freed storage and dollars saved accumulate on the dashboard, with undo one click away.",
  ],
];

function Landing() {
  return (
    <main className="min-h-screen">
      <nav className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <span className="font-semibold text-lg">Indexterity</span>
        <Link to="/app" className="rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm">
          Sign in
        </Link>
      </nav>

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-20 text-center">
        <h1 className="font-semibold text-5xl leading-tight tracking-tight">
          Your MongoDB indexes, on autopilot —{" "}
          <span className="text-primary">with a hand brake.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Indexterity watches index usage, proposes drops and creates with confidence scores, and
          applies them through a hide → observe → drop pipeline that can always back out. Read-only
          until you say otherwise.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            to="/app"
            className="rounded-md bg-primary px-6 py-3 font-medium text-primary-foreground"
          >
            Get started
          </Link>
          <a href="#how" className="rounded-md border px-6 py-3 font-medium text-sm">
            How it works
          </a>
        </div>
        <p className="mt-6 font-mono text-muted-foreground text-xs">
          PROPOSED → APPROVED → hidden → observed → dropped · undo anytime
        </p>
      </section>

      <section className="border-y bg-secondary/50">
        <div className="mx-auto grid max-w-5xl gap-6 px-6 py-16 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-lg border bg-background p-5">
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-muted-foreground text-sm">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-center font-semibold text-3xl">How it works</h2>
        <ol className="mt-8 space-y-6">
          {STEPS.map(([title, body], index) => (
            <li key={title} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-sm">
                {index + 1}
              </span>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-muted-foreground text-sm">{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-12 text-center">
          <Link
            to="/app"
            className="rounded-md bg-primary px-6 py-3 font-medium text-primary-foreground"
          >
            Connect a cluster
          </Link>
          <p className="mt-3 text-muted-foreground text-sm">
            Starts read-only. Your documents are never read, and never touched.
          </p>
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-muted-foreground text-sm">
          <span>Indexterity — index dexterity for MongoDB.</span>
          <span className="font-mono text-xs">indexes only · documents never</span>
        </div>
      </footer>
    </main>
  );
}

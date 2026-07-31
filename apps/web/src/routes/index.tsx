import { createFileRoute, Link } from "@tanstack/react-router";
import { jsonLd, seoTags, siteOrigin } from "../lib/seo";

const TITLE = "Indexterity — automatic MongoDB index management";
// Kept under ~155 characters so search results show it whole.
const DESCRIPTION =
  "Find unused, redundant and missing MongoDB indexes, then apply changes through a " +
  "hide → observe → drop pipeline you can always undo. Read-only by default.";

// Marketing landing at / — fully static (no loader, no api calls), so it
// renders even when the control plane is down. The dashboard lives at /app.
// This is the only indexable page; everything else is noindex.
export const Route = createFileRoute("/")({
  head: () => {
    const { meta, links } = seoTags({ title: TITLE, description: DESCRIPTION, path: "/" });
    const origin = siteOrigin();
    return {
      meta,
      links,
      scripts: [
        jsonLd({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Indexterity",
          applicationCategory: "DeveloperApplication",
          applicationSubCategory: "Database tooling",
          operatingSystem: "Web-based, self-hostable (Docker, Kubernetes)",
          description: DESCRIPTION,
          url: origin,
          featureList: FEATURES.map((feature) => feature.title),
        }),
        jsonLd({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map((entry) => ({
            "@type": "Question",
            name: entry.question,
            acceptedAnswer: { "@type": "Answer", text: entry.answer },
          })),
        }),
      ],
    };
  },
  component: Landing,
});

const FEATURES = [
  {
    title: "Read-only by default",
    body: "Connect a cluster and Indexterity analyzes forever without touching it. Writes happen only after an owner flips the cluster live — and even then, indexes only, never your documents.",
  },
  {
    title: "A safety pipeline, not a script",
    body: "Drops go hide → observe → regression gate → pre-flight → drop. Anything that slows reads is un-hidden, remembered, and cooled down. Undo rebuilds a dropped index from its recorded spec.",
  },
  {
    title: "Confidence scores",
    body: "Every recommendation carries a 0–100 score from usage history, redundancy, size and scan frequency. Set an auto-approve threshold, or approve by hand — past regressions cut the score hard either way.",
  },
  {
    title: "Workload-aware index creation",
    body: "Recurring query shapes from $queryStats (no profiler needed) or the profiler become Equality → Sort → Range compounds with correct sort directions, partial indexes for constant filters, and TTL advisories for manual age-based cleanups.",
  },
  {
    title: "Proof, not promises",
    body: "Freed bytes and their $/month, index-count deltas, and per-collection read/write latency charts — before and after. New indexes are watched too: if writes regress, the build rolls back automatically.",
  },
  {
    title: "Built for teams",
    body: "Organizations with owner/member roles, email invites, an immutable audit trail of every executed operation, engine alerts by email and a weekly digest of what read-only clusters would have done.",
  },
];

const STEPS = [
  [
    "Connect read-only",
    "Paste a connection string. Indexterity first reports exactly which privileges it has, and offers to create its own least-privilege user. Credentials are envelope-encrypted at rest.",
  ],
  [
    "Collect & score",
    "Index usage, sizes, latency and query shapes on a schedule — every recommendation arrives scored and explained in plain language.",
  ],
  [
    "Approve — or set a threshold",
    "Click approve, or let a score threshold promote confident recommendations. The observe gates still stand between any recommendation and a drop.",
  ],
  [
    "Watch the ROI",
    "Latency trends, freed storage and dollars saved accumulate on the dashboard, attributed per index, with undo one click away.",
  ],
];

// Real questions, answered honestly — these also feed the FAQPage structured
// data above, so keep answers self-contained.
const FAQ = [
  {
    question: "Does Indexterity read my data?",
    answer:
      "No. It connects as a least-privilege user whose role grants index management and statistics only — there is no find privilege on your collections, so the server itself refuses any attempt to read documents. Index usage, sizes and latency all come from $indexStats and $collStats, which never expose document contents.",
  },
  {
    question: "How does it decide a MongoDB index is unused?",
    answer:
      "From $indexStats operation counters, summed across every replica-set member and shard, over at least three snapshots. An index with no operations in any snapshot is flat-zero; one that used to be busy and then went quiet is treated as periodic-dead. Indexes that are still used periodically are never proposed for removal.",
  },
  {
    question: "What happens if dropping an index hurts performance?",
    answer:
      "A drop is never the first action. The index is hidden first — instant and reversible — and the collection's read latency is baselined. If average read latency rises past the baseline during the observe window, the index is un-hidden automatically, the recommendation is rejected, and the index enters a cooldown so it is not proposed again. Even after a real drop, undo rebuilds it from the spec recorded at drop time.",
  },
  {
    question: "How long does an index stay hidden before it is dropped?",
    answer:
      "Thirty days by default, and the window adapts to the index itself: usage with long gaps (a monthly report, a weekly batch) extends it to cover a full cycle, while an index proven idle across a much longer history shortens it. The window chosen for each drop, and why, is recorded in the audit trail.",
  },
  {
    question: "Does it work with Atlas, self-hosted MongoDB and sharded clusters?",
    answer:
      "Yes. Sharded clusters are handled explicitly: statistics are summed across shards, and shard-key backing indexes are protected from removal. On Atlas, user management belongs to Atlas, so you create the scoped role there and connect with its string; self-hosted and community deployments can have Indexterity create the user for you.",
  },
  {
    question: "Which MongoDB privileges does it need?",
    answer:
      "listDatabases, listCollections, listIndexes, indexStats and collStats to analyze; createIndex, dropIndex and collMod to apply changes; optionally reading system.profile or $queryStats for workload analysis. Before storing anything, Indexterity checks the connection string and tells you exactly which of these are missing and what each one enables.",
  },
  {
    question: "Can it create missing indexes, not just drop unused ones?",
    answer:
      "Yes. Recurring collection-scan query shapes become index recommendations in Equality → Sort → Range order with correct sort directions, folded together when one index can serve several shapes. A shape must recur before it counts, so a heavy query someone runs once by hand never leaves an index behind.",
  },
];

function Landing() {
  return (
    <>
      <header className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <span className="font-semibold text-lg">Indexterity</span>
        <nav aria-label="Main">
          <Link
            to="/app"
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <main className="min-h-screen">
        <section className="mx-auto max-w-3xl px-6 pt-16 pb-20 text-center">
          <h1 className="font-semibold text-5xl leading-tight tracking-tight">
            Automatic MongoDB index management —{" "}
            <span className="text-primary">with a hand brake.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Indexterity watches index usage, proposes drops and creates with confidence scores, and
            applies them through a hide → observe → drop pipeline that can always back out.
            Read-only until you say otherwise.
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

        <section aria-labelledby="features" className="border-y bg-secondary/50">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 id="features" className="text-center font-semibold text-3xl">
              What Indexterity does for your indexes
            </h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {FEATURES.map((feature) => (
                <article key={feature.title} className="rounded-lg border bg-background p-5">
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-muted-foreground text-sm">{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-heading" className="mx-auto max-w-3xl px-6 py-16">
          <h2 id="how-heading" className="text-center font-semibold text-3xl">
            How it works
          </h2>
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

        <section aria-labelledby="faq" className="border-t bg-secondary/50">
          <div className="mx-auto max-w-3xl px-6 py-16">
            <h2 id="faq" className="text-center font-semibold text-3xl">
              Frequently asked questions
            </h2>
            <dl className="mt-8 space-y-6">
              {FAQ.map((entry) => (
                <div key={entry.question} className="rounded-lg border bg-background p-5">
                  <dt className="font-semibold">{entry.question}</dt>
                  <dd className="mt-2 text-muted-foreground text-sm">{entry.answer}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-muted-foreground text-sm">
          <span>Indexterity — index dexterity for MongoDB.</span>
          <span className="font-mono text-xs">indexes only · documents never</span>
        </div>
      </footer>
    </>
  );
}

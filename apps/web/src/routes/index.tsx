import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon, Undo2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { jsonLd, seoTags, siteOrigin } from "../lib/seo";

const TITLE = "Indexterity — automatic index management for MongoDB and SQL Server";
// Kept under ~155 characters so search results show it whole.
const DESCRIPTION =
  "Find unused, redundant and missing MongoDB and SQL Server indexes. Apply them " +
  "through a pipeline that observes before it drops. Read-only by default.";

const PIPELINE = ["PROPOSED", "APPROVED", "hidden", "observed", "dropped"];

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
    body: "A drop is hidden first, observed, then put through a regression gate and a pre-flight before it happens. Anything that slows reads is un-hidden, remembered, and cooled down. Undo rebuilds a dropped index from its recorded spec.",
  },
  {
    title: "Confidence scores",
    body: "Every recommendation carries a 0–100 score from usage history, redundancy, size and scan frequency. Set an auto-approve threshold, or approve by hand — past regressions cut the score hard either way.",
  },
  {
    title: "Workload-aware index creation",
    body: "Recurring query shapes — from $queryStats or the profiler on MongoDB, from Query Store on SQL Server — become compound indexes in Equality, Sort, Range order with correct sort directions, partial indexes for constant filters, and TTL advisories for manual age-based cleanups. Queries that sort in memory count too, not just the ones that scan everything.",
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
    question: "How do I get access?",
    answer:
      "Sign up on the sign-in page. Whether that is open to anyone is a per-deployment switch (SIGNUP_MODE: open, invite or closed) rather than something this page can promise: an install that takes invitations only says so at sign-up and points you at the invite mail. If you self-host, the first account you create bootstraps the install and can invite the rest of your team.",
  },
  {
    question: "Does Indexterity read my data?",
    answer:
      "No. It connects as a least-privilege user granted index management and statistics only — no read privilege on your collections or tables, so the server itself refuses any attempt to read what is stored. Index usage, sizes and latency all come from the engine's own statistics views — $indexStats and $collStats on MongoDB, sys.dm_db_index_usage_stats and sys.dm_db_partition_stats on SQL Server — none of which expose stored values.",
  },
  {
    question: "How does it decide an index is unused?",
    answer:
      "From the engine's own per-index operation counters, over at least three snapshots: $indexStats on MongoDB, summed across every replica-set member and shard, and sys.dm_db_index_usage_stats on SQL Server, read per replica. An index with no operations in any snapshot is flat-zero; one that used to be busy and then went quiet is treated as periodic-dead. Indexes that are still used periodically are never proposed for removal. A counter that goes backwards — a restart, a rebuild, a statistics reset — is treated as a fact about the counter rather than about usage, and never as an index falling idle.",
  },
  {
    question: "What happens if dropping an index hurts performance?",
    answer:
      "A drop is never the first action. The index is hidden first and the read latency of its collection or table is baselined. If average read latency rises past the baseline during the observe window, the index is un-hidden automatically, the recommendation is rejected, and the index enters a cooldown so it is not proposed again. What hiding costs depends on the engine, and Indexterity says which before it acts: on MongoDB it is instant and free both ways, while on SQL Server the un-hide is an exact but not instant rebuild. Even after a real drop, undo rebuilds the index from the spec recorded at drop time.",
  },
  {
    question: "How long does an index stay hidden before it is dropped?",
    answer:
      "Thirty days by default, and the window adapts to the index itself — set by whichever question is still open. Will anything want this again? That runs at the cadence of the workload, so usage with long gaps (a monthly report, a weekly batch) extends the window to cover a full cycle. Did hiding it hurt? That runs at the rate the index is queried, so one still serving traffic when it is hidden answers within days and is watched for a week rather than a month. An index proven idle across a much longer history is shortened too: the history already was the observation. The window chosen for each drop, and why, is recorded in the audit trail.",
  },
  {
    question: "Which deployments does it work with?",
    answer:
      "MongoDB 6.0 to 8.x — Atlas, self-hosted and sharded — and SQL Server 2016 and newer. Sharded clusters are handled explicitly: statistics are summed across shards, and shard-key backing indexes are protected from removal. Replicas are read one node at a time, because a replica-set member and an availability-group secondary each keep their own usage counters, and an index idle on the primary may be the one a reporting replica lives on. On Atlas, user management belongs to Atlas, so you create the scoped role there and connect with its string; self-hosted MongoDB and SQL Server can have Indexterity create the user for you.",
  },
  {
    question: "Which MongoDB privileges does it need?",
    answer:
      "listDatabases, listCollections, listIndexes, indexStats and collStats to analyze; createIndex, dropIndex and collMod to apply changes; optionally system.profile or $queryStats for workload analysis, and serverStatus for the health probe. serverStatus is the one that reads beyond index metadata — it also exposes connection counts and storage-engine internals — so it is optional and a cluster without it works fine. Before storing anything, Indexterity checks the connection string and tells you exactly which of these are missing and what each one enables.",
  },
  {
    question: "Which SQL Server permissions does it need?",
    answer:
      "VIEW SERVER STATE to read sys.dm_db_index_usage_stats, which is server-scoped; VIEW DATABASE STATE for sizes, row counts and Query Store in each database; and ALTER on the schemas whose indexes it may change. Query Store is the optional one — without it the drop side works as normal and there are simply no create-side recommendations. Letting Indexterity create its own login instead needs ALTER ANY LOGIN, ALTER ANY USER in each database, and CONTROL SERVER to grant VIEW SERVER STATE. Whichever route you take, the preflight names every permission it looked for and what each one enables.",
  },
  {
    question: "Can it create missing indexes, not just drop unused ones?",
    answer:
      "Yes. Recurring scans of a whole collection or table become index recommendations in Equality, Sort, Range order with correct sort directions, folded together when one index can serve several shapes. So do queries that find their rows through an index and then sort them in memory — invisible to any scan test, and the failure mode that ends in an error rather than slowness. On SQL Server the server's own missing-index suggestions are folded in behind the same recurrence and cost gates as every other signal. A shape must recur before it counts, so a heavy query someone runs once by hand never leaves an index behind.",
  },
];

function Landing() {
  return (
    <>
      <header className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <span className="font-semibold text-lg">Indexterity</span>
        <nav aria-label="Main">
          <Button asChild size="sm">
            <Link to="/app">Sign in</Link>
          </Button>
        </nav>
      </header>

      <main className="min-h-screen">
        <section className="mx-auto max-w-3xl px-6 pt-16 pb-20 text-center">
          <h1 className="font-semibold text-5xl leading-tight tracking-tight">
            Automatic index management for MongoDB and SQL Server —{" "}
            <span className="text-primary">with a hand brake.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Indexterity watches index usage, proposes drops and creates with confidence scores, and
            applies them through a pipeline that hides, observes, then drops, and can always back
            out. Read-only until you say otherwise.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/app">Get started</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="#how">How it works</a>
            </Button>
          </div>
          <p className="mt-4 text-muted-foreground text-sm">
            MongoDB 6.0 to 8.x and SQL Server 2016+. Hosted, or self-host the same image.
          </p>
          {/* The pipeline as a real ordered list rather than a string of
              arrows: a screen reader announces five steps in order, and the
              separators are decorative icons it skips entirely. */}
          <ol className="mt-6 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 font-mono text-muted-foreground text-xs">
            {PIPELINE.map((stage, i) => (
              <li key={stage} className="flex items-center gap-x-1.5">
                {i > 0 && <ChevronRightIcon aria-hidden="true" className="size-3 opacity-60" />}
                {stage}
              </li>
            ))}
            <li className="flex items-center gap-x-1.5 pl-1">
              <Undo2Icon aria-hidden="true" className="size-3" />
              undo anytime
            </li>
          </ol>
        </section>

        <section aria-labelledby="features" className="border-y bg-secondary/50">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 id="features" className="text-center font-semibold text-3xl">
              What Indexterity does for your indexes
            </h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {FEATURES.map((feature) => (
                <Card key={feature.title}>
                  <CardHeader>
                    {/* A real h3: CardTitle renders a div, and the landing page
                        depends on its h1 → h2 → h3 outline. */}
                    <h3 className="font-semibold leading-none">{feature.title}</h3>
                  </CardHeader>
                  <CardContent className="text-muted-foreground text-sm">
                    {feature.body}
                  </CardContent>
                </Card>
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
            <Button asChild size="lg">
              <Link to="/app">Get started</Link>
            </Button>
            <p className="mt-3 text-muted-foreground text-sm">
              Clusters start read-only. Your documents are never read, and never touched.
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
                <Card key={entry.question} className="p-5">
                  <dt className="font-semibold">{entry.question}</dt>
                  <dd className="text-muted-foreground text-sm">{entry.answer}</dd>
                </Card>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-muted-foreground text-sm">
          <span>Indexterity — index dexterity for MongoDB and SQL Server.</span>
          <span className="font-mono text-xs">indexes only · documents never</span>
        </div>
      </footer>
    </>
  );
}

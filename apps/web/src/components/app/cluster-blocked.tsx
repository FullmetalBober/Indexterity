import type { ClusterBlock } from "@repo/contracts";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { useMounted } from "~/lib/hydration";

// Why the numbers below are old, said out loud.
//
// The condition was always known — the worker records a metric, logs a line and
// mails the owners once a day — and none of it reached this screen. So a cluster
// nobody could reach looked exactly like a cluster with nothing left to collect:
// a "last collected 7 days ago" badge, which has innocent causes and reads as
// "nothing is obviously wrong". A problem that renders as an absence is the one
// shape of failure a dashboard must not have.
//
// Under the heading and above the tabs, deliberately: it is a fact about the
// cluster rather than about one tab, and it is the first thing to read on every
// one of them while it is true.

interface Copy {
  /** For the badge beside the cluster's name. Short enough to sit in a row. */
  readonly badge: string;
  readonly title: string;
  /** What is actually happening, in the reader's terms. */
  readonly what: string;
  /** What to do about it — and who can. */
  readonly next: string;
}

const COPY: Record<string, Copy> = {
  UNREACHABLE: {
    badge: "cannot be reached",
    title: "Indexterity cannot reach this cluster",
    what:
      "Nothing has been collected since then, so every figure on this page predates it. " +
      "Usage-based recommendations are withheld while the history has a hole in it.",
    next:
      "Usual causes: the cluster is paused or down, its network rules changed, or the stored " +
      "connection string is stale. Collection resumes on its own once it answers again — " +
      "nothing here needs to be reset.",
  },
  TUNNEL_DOWN: {
    badge: "VPN tunnel down",
    title: "The VPN tunnel to this cluster is not up",
    what:
      "The database itself may be answering perfectly; what is not answering is the gateway. " +
      "Nothing has been collected since then.",
    next:
      "Check the tunnel under Settings → VPN tunnels and press Test — it will say whether the " +
      "gateway answers now. Collection resumes once the handshake does.",
  },
  INSECURE: {
    badge: "refused: not using TLS",
    title: "Indexterity is declining to connect to this cluster",
    what:
      "The stored connection string would connect in plaintext, and every connection to a " +
      "customer database has to be encrypted. So nothing was dialled — this is a refusal, not " +
      "a failure to reach it.",
    next:
      "Reconnect the cluster with a string that enables TLS and the pipeline resumes on the " +
      "next tick. No retry can fix it in the meantime.",
  },
  CREDENTIALS: {
    badge: "credentials unreadable",
    title: "This cluster's stored credentials cannot be opened",
    what:
      "The connection string is sealed with a key this deployment cannot read, so nothing can " +
      "be dialled. Nothing has been collected since then.",
    next:
      "This one needs whoever runs this Indexterity, not the cluster's owner: the master key " +
      "that sealed it has to be present. Rotating the cluster's credentials also fixes it.",
  },
  UNSUPPORTED: {
    badge: "version not supported",
    title: "This server's version is not supported",
    what:
      "The pipeline reads counters this major series does not provide, so it stopped rather " +
      "than reporting numbers it cannot stand behind.",
    next: "No retry fixes a version. Upgrading the server resumes collection on the next tick.",
  },
  TIMED_OUT: {
    badge: "too slow to finish",
    title: "Reading this cluster takes longer than Indexterity will wait",
    what:
      "A step ran past the time it is allowed and was abandoned, so it did nothing. This is " +
      "not a failure so much as a step that does not fit: usually a very large or very busy " +
      "cluster, or one reached over a slow link.",
    next:
      "Nothing was executed and nothing was lost, and it tries again on the next tick. If this " +
      "cluster genuinely needs longer, whoever runs this Indexterity can raise the budget — " +
      "the setting is CLUSTER_PASS_BUDGET_MS. Applying a change is never cut off this way.",
  },
  // No ERROR entry: it is the one reason whose wording depends on WHICH pass
  // failed, and that is built below.
};

// The passes, in the reader's words rather than the queue's (#408).
//
// Only ERROR needs these. Every other reason is a dial failure — unreachable,
// no tunnel, refused for TLS, unreadable credentials, unsupported version — and
// those stop every pass alike, so "nothing has been collected" is true whichever
// one happened to notice. ERROR is the opposite: it is what a pass lands on when
// the dial worked and the pass itself did not, so naming collection there is
// wrong exactly when it matters.
const PASS: Record<string, string> = {
  collect: "Collecting from this cluster",
  classify: "Classifying this cluster's index usage",
  suggest: "Working out recommendations for this cluster",
  apply: "Applying an approved change to this cluster",
  finalize: "Finishing an applied change on this cluster",
  probe: "Measuring this cluster after a change",
};

// A pass this build has no wording for still has to render, for the reason a
// reason it does not know does: the field is text so that adding a pass is a
// constant rather than a migration, and that is only safe if the reader
// degrades. So an unknown pass is quoted as itself, and a block written before
// the column existed (task === null) gets the general wording — which is what
// every block used to get.
function errorCopy(task: string | null): Copy {
  const known = task === null ? undefined : PASS[task];
  const subject = known ?? (task === null ? "A step in the pipeline" : `The ${task} step`);
  return {
    badge: task === null ? "a step is failing" : `${task} failing`,
    title: `${subject} is failing`,
    what:
      "Something the pipeline does not have a name for went wrong, and it has been retrying. " +
      (task === "collect"
        ? "Nothing has been collected since then."
        : "Other steps may still be running, so some figures on this page can be newer than " +
          "others."),
    next:
      "The message below is the failure itself. If it means nothing to you, it will mean " +
      "something to whoever runs this Indexterity — the same line is in the logs.",
  };
}

// A reason this build does not know still has to render. The column is text so
// that adding one is a constant rather than a migration, which is only safe if
// an older reader degrades instead of breaking — the same rule the security
// trail's labels follow.
function copyFor(reason: string, task: string | null = null): Copy {
  if (reason === "ERROR") return errorCopy(task);
  return (
    COPY[reason] ?? {
      badge: "collection stopped",
      title: "Collection against this cluster has stopped",
      what: "Nothing has been collected since then.",
      next: `The pipeline recorded this as "${reason}", which this dashboard does not have wording for yet.`,
    }
  );
}

export function blockedBadge(reason: string, task: string | null = null): string {
  return copyFor(reason, task).badge;
}

/**
 * How long it has been going on, which is the part that decides whether somebody
 * acts. Clock-dependent, so callers resolve it after hydration.
 */
export function blockedFor(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? "for a minute or so" : `for ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "for an hour" : `for ${hours} hours`;
  const days = Math.floor(hours / 24);
  return `for ${days} days`;
}

export function ClusterBlockedBanner({
  clusterId,
  block,
}: {
  clusterId: string;
  block: ClusterBlock;
}) {
  const copy = copyFor(block.reason, block.task);
  // The duration is the reader's clock against a stored timestamp, so it waits
  // for hydration rather than differing between the two renders. The rest of the
  // banner does not — the warning itself must be in the server's HTML, or a
  // reader with JavaScript off sees the same absence this exists to fix.
  const duration = useMounted() ? blockedFor(block.since) : null;

  return (
    <Alert variant="destructive" className="mt-4">
      <AlertTitle>
        {copy.title}
        {duration === null ? null : <span className="font-normal"> — {duration}</span>}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{copy.what}</p>
        {block.detail === "" ? null : (
          // The failure in its own words. Monospaced because it usually is a
          // driver's message, addresses and all — and those are the reader's own.
          <p className="font-mono text-xs">{block.detail}</p>
        )}
        <p>{copy.next}</p>
        {block.reason === "TUNNEL_DOWN" ? (
          <Link to="/app/settings/tunnels" className="underline">
            Go to VPN tunnels
          </Link>
        ) : null}
        {block.reason === "INSECURE" || block.reason === "CREDENTIALS" ? (
          <Link to="/app/clusters/$clusterId/settings" params={{ clusterId }} className="underline">
            Go to this cluster's settings
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

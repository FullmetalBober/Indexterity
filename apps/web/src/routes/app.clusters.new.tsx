// Connecting a cluster: onboarding, and its own address.
//
// It was a card stapled under the ROI numbers on the dashboard, which put the
// first thing a new account has to do at the bottom of a page that has nothing
// on it until they have done it. Two things follow from moving it (#81):
//
//   - /app sends an org with no clusters straight here, so the empty state IS
//     this page rather than a dashboard of zeroes with a form underneath.
//   - It is reachable from the rail at any time, which is what somebody
//     connecting their second cluster is looking for and never found under the
//     first cluster's numbers.
import { createFileRoute } from "@tanstack/react-router";
import { ConnectClusterForm } from "~/components/app/connect-cluster-form";
import { useClusters, useOrg } from "~/lib/queries/shell";
import { CLUSTER_USER_DOCS_HREF } from "~/lib/site";

export const Route = createFileRoute("/app/clusters/new")({
  // Nothing of its own to fetch: the org (for the plan's cluster quota) and the
  // cluster list both came with the /app layout.
  head: () => ({ meta: [{ title: "Connect a cluster — Indexterity" }] }),
  component: ConnectCluster,
});

function ConnectCluster() {
  const org = useOrg();
  const clusters = useClusters();
  const first = clusters.length === 0;

  return (
    // Capped, unlike a cluster's overview. That page is tables and time series
    // and wants every pixel; this one is two text fields, and a connection
    // string box eleven hundred pixels wide is not easier to read a typo out of.
    <div className="max-w-3xl">
      <h1 className="font-semibold text-2xl">Connect a cluster</h1>
      <p className="mt-2 text-muted-foreground">
        {first
          ? // The one moment worth saying what happens next: nothing on this
            // account has ever run, so "read-only" and "six hours" are the two
            // facts that decide whether the next screen looks broken.
            // "within six hours" until #178 made the pass hourly and #231 gave
            // it a tick that fires at boot — so the honest answer to "when does
            // something happen" is now minutes, and a first impression that
            // promises six hours is a reader who closes the tab.
            "Indexterity reads how your indexes are used and proposes what to drop, merge or build. Paste a connection string and it will check what those credentials can do before storing anything — the cluster starts read-only, and the first collect is queued as soon as it is connected."
          : "Every cluster is analyzed on its own, with its own policy and its own history."}
      </p>

      <ConnectClusterForm
        plan={org?.plan ?? null}
        requireLeastPrivilege={org?.policy.requireLeastPrivilege ?? false}
      />

      {first ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Would rather not hand over your own credentials? Paste a string that can create users and
          Indexterity will make itself a dedicated least-privilege one instead —{" "}
          <a href={CLUSTER_USER_DOCS_HREF} className="underline">
            the exact role is here
          </a>
          .
        </p>
      ) : null}
    </div>
  );
}

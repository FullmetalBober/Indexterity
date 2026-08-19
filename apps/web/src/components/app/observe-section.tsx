// The observe selection on a cluster that already exists (#244).
//
// The connect form's copy of this question is answered from a diagnosis; this one
// dials the cluster, because the whole point of editing it later is to include a
// database that was not there at onboarding. So this section is the only place in
// the app where opening a page reaches a customer's server, and it is why the read
// is its own query key with a stale time rather than part of the cluster list.
import type { ClusterDatabases } from "@repo/contracts";
import { useState } from "react";
import { MIN_DATABASES_TO_CHOOSE, ObserveDatabases } from "~/components/app/observe-databases";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { useSetObservedDatabases } from "~/lib/queries/mutations/cluster";

// Same selection, either spelling. Used to decide whether Save has anything to
// do: null and a complete list both mean "all of them", so re-ticking the last
// box leaves nothing to save.
function sameSelection(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((name) => b.includes(name));
}

// Only what this section reads, as the other cluster sections do: the id it writes
// to, and whether the cluster runs as a login we created — which decides whether
// widening the selection can meet a grant that does not cover it.
interface ObservedCluster {
  readonly id: string;
  readonly provisionedUsername: string | null;
}

export function ObserveSection({
  cluster,
  databases,
}: {
  readonly cluster: ObservedCluster;
  readonly databases: ClusterDatabases;
}) {
  // The stored selection is the starting point, and the draft is local until Save:
  // a checkbox that dials the api per click would make narrowing a twelve-database
  // cluster twelve writes, each of them discarding proposals.
  const [draft, setDraft] = useState<readonly string[] | null>(databases.observed);
  const save = useSetObservedDatabases(cluster.id, { onSaved: () => undefined });

  // A stored name the cluster no longer reports. Not pruned by the api — the filter
  // intersects on every collect, so a database that comes back is picked up again —
  // which means this is the only place a reader can see one at all.
  //
  // Declared above the single-database branch and drawn inside it too: a cluster
  // whose databases were dropped until one is left is exactly the case that
  // produces a stale selection, so that is the last branch that may stay silent
  // about it.
  const missing =
    databases.observed === null
      ? []
      : databases.observed.filter((name) => !databases.available.includes(name));
  const missingAlert =
    missing.length === 0 ? null : (
      <Alert>
        <AlertTitle>
          {missing.length === 1 ? "A selected database" : "Selected databases"} no longer on this
          cluster
        </AlertTitle>
        <AlertDescription>
          <code>{missing.join(", ")}</code> {missing.length === 1 ? "is" : "are"} still in the
          selection and the cluster does not report {missing.length === 1 ? "it" : "them"} — a drop
          or a rename. Nothing breaks: each collect walks what is both selected and there, and a
          database that comes back is picked up again.
        </AlertDescription>
      </Alert>
    );

  // A one-database cluster has nothing to choose between. Drawn as a sentence
  // rather than as nothing at all, because "which databases are observed" is a
  // question the page should still answer — silence would read as a missing
  // feature rather than as an answer.
  if (databases.available.length < MIN_DATABASES_TO_CHOOSE) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Databases</CardTitle>
          <CardDescription>
            This cluster has one database, <code>{databases.available[0] ?? "none"}</code>, and it
            is observed. The choice appears here when there is more than one.
          </CardDescription>
        </CardHeader>
        {missingAlert === null ? null : <CardContent>{missingAlert}</CardContent>}
      </Card>
    );
  }

  const unobserved = databases.available.filter(
    (name) => draft !== null && !draft.includes(name),
  ).length;
  const dirty = !sameSelection(draft, databases.observed);
  const empty = draft !== null && draft.length === 0;
  // Whether the draft asks us to observe a database we were not observing. Only
  // widening can meet a grant that does not cover it — narrowing never can — and a
  // stored null was already observing everything, so nothing can widen it.
  const stored = databases.observed;
  const widened =
    stored !== null && (draft === null || draft.some((name) => !stored.includes(name)));

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Databases</CardTitle>
        <CardDescription>
          Which of this cluster's databases the engine looks at. Everything already measured for a
          database you untick is kept — the next collect simply stops walking it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ObserveDatabases
          available={databases.available}
          selected={draft}
          onChange={setDraft}
          disabled={save.isPending}
          context="settings"
        />

        {/* The cost of an allowlist, said out loud. A database added to this
            cluster tomorrow is NOT observed while a narrowed selection is in
            force, and nothing else on the screen would ever mention it — which is
            how "why are there no recommendations for the new service" becomes a
            support thread six months from now. */}
        {unobserved > 0 ? (
          <p className="text-muted-foreground text-xs">
            {unobserved} {unobserved === 1 ? "database is" : "databases are"} not observed, and a
            database added to this cluster later will not be either until you tick it here.
          </p>
        ) : null}

        {/* Only for a cluster running as a login we created. Its grants were made
            at provisioning time against the databases selected then, and there is
            no admin string left to widen them with — so ticking a new database can
            produce a permission gap the reader would otherwise diagnose as a bug in
            the collect. */}
        {cluster.provisionedUsername !== null && widened ? (
          <Alert>
            <AlertTitle>This cluster runs as a user Indexterity created</AlertTitle>
            <AlertDescription>
              <code>{cluster.provisionedUsername}</code> was granted access to the databases
              selected when it was created. A database added here may report missing privileges
              until it is granted on the cluster — or rotate to a connection string that already has
              what the engine needs.
            </AlertDescription>
          </Alert>
        ) : null}

        {missingAlert}

        <div className="flex items-center gap-3">
          <Button disabled={!dirty || empty || save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {dirty ? (
            <Button
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setDraft(databases.observed)}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// Drawn while the dial is in flight, which on an unreachable cluster is as long
// as the driver's timeout — long enough that an outline is the difference between
// a page that is loading and a page that is broken.
export function ObserveSectionSkeleton() {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Databases</CardTitle>
        <CardDescription>Asking the cluster which databases it has…</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-36" />
      </CardContent>
    </Card>
  );
}

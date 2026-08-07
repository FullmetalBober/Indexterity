import { type ConnectionDiagnosis, createClusterInput, type PlanInfo } from "@repo/contracts";
import { useState } from "react";
import { usage } from "~/components/app/format";
import { PrivilegeList } from "~/components/app/privilege-list";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import {
  useCheckConnection,
  useConnectCluster,
  useProvisionCluster,
} from "~/lib/queries/mutations/cluster";
import { CLUSTER_USER_DOCS_HREF } from "~/lib/site";

// The api's own rules for these two fields, so a string it will refuse for being
// empty is refused here by the same schema rather than by a second copy of it.
const NAME = createClusterInput.shape.name;
const CONNECTION_STRING = createClusterInput.shape.connectionString;

// The plan the clusters are counted against, or null while the org read has not
// arrived — in which case the quota simply is not drawn. It is a warning, not a
// gate: the api is the one that refuses, and it refuses on the same numbers.
export function ConnectClusterForm({ plan }: { plan: PlanInfo | null }) {
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  const [provisioned, setProvisioned] = useState<{
    username: string;
    connectionString: string;
  } | null>(null);

  // Every path starts by clearing what the last one said, so a stale error
  // cannot sit above a fresh answer.
  function onStart() {
    setError(null);
  }

  // A connect succeeded: empty the form, but keep any provisioned string, which
  // is the only copy the reader will ever see.
  function onConnected() {
    form.reset();
    setDiagnosis(null);
  }

  const check = useCheckConnection({
    onStart: () => {
      onStart();
      setDiagnosis(null);
      setProvisioned(null);
    },
    onDiagnosis: setDiagnosis,
    onError: setError,
  });

  const connectAsIs = useConnectCluster({ onStart, onConnected, onError: setError });

  const provision = useProvisionCluster({
    onStart,
    onConnected,
    onError: setError,
    onProvisioned: setProvisioned,
  });

  const form = useAppForm({
    defaultValues: { name: "", connectionString: "" },
    // Submitting is the preflight, not the connect: nothing is stored until the
    // reader has seen what the string can do and picked one of the answers below.
    onSubmit: ({ value }) => check.mutate(value.connectionString),
  });

  // One flag over three mutations: any of them in flight means the form is
  // waiting on the api, and the second click would be about stale fields.
  const busy = check.isPending || connectAsIs.isPending || provision.isPending;

  // Read at click time rather than at render: the two buttons under a diagnosis
  // are not the form's submit, and the form store deliberately does not re-render
  // this component when a field changes.
  const credentials = () => form.state.values;

  // The meter this form spends, read before a word is typed. Unlimited plans
  // have a null cap and can never be full.
  const full = plan !== null && plan.maxClusters !== null && plan.clustersUsed >= plan.maxClusters;

  return (
    <Card className="mt-8">
      {/* No title of its own: the page this sits on is called "Connect a
          cluster" and there is nothing else on it, so a card repeating the
          heading is a second heading for one thing. */}
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardDescription>
            Paste any connection string — Indexterity checks what it can do before storing anything.
            Clusters start in read-only mode.
          </CardDescription>
          {/* The count belongs beside the form that spends it, not on the org
              page: a limit nobody sees until it refuses them is a 402 in the
              middle of someone's work. */}
          {plan !== null ? (
            <span
              className={
                full
                  ? "shrink-0 text-destructive text-xs"
                  : "shrink-0 text-muted-foreground text-xs"
              }
            >
              {usage(plan.clustersUsed, plan.maxClusters)} clusters on the {plan.plan} plan
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan !== null && full ? (
          <Alert variant="destructive">
            <AlertTitle>No room for another cluster</AlertTitle>
            {/* Nothing is disabled below. Checking a string stores nothing and
                is still worth doing, and the api owns the refusal — a button
                greyed out by a stale count would be a lie either way. */}
            <AlertDescription>
              The {plan.plan} plan allows {plan.maxClusters}{" "}
              {plan.maxClusters === 1 ? "cluster" : "clusters"}. Checking a connection string still
              works, but connecting one will be refused until you disconnect a cluster or move to a
              plan with room for more.
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="name" validators={{ onChange: NAME }}>
            {(field) => <field.TextField label="Name" className="w-48" placeholder="Production" />}
          </form.AppField>
          <form.AppField
            name="connectionString"
            validators={{ onChange: CONNECTION_STRING }}
            // A diagnosis describes one exact string. Edit the string and it
            // describes nothing — better no answer than last string's answer.
            listeners={{ onChange: () => setDiagnosis(null) }}
          >
            {(field) => (
              <field.TextField
                label="Connection string"
                className="font-mono"
                placeholder="mongodb://user:pass@host:27017"
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton pending={busy}>
              {busy ? "Checking…" : "Check access"}
            </form.SubmitButton>
          </form.AppForm>
        </form>

        {error !== null ? (
          <Alert variant="destructive">
            <AlertTitle>Could not check the connection</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {diagnosis !== null && !diagnosis.reachable ? (
          <Alert variant="destructive">
            <AlertTitle>Cannot use this connection string</AlertTitle>
            <AlertDescription>{diagnosis.message}</AlertDescription>
          </Alert>
        ) : null}

        {diagnosis?.reachable === true ? (
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">
              Connected as{" "}
              <code>{diagnosis.username ?? (diagnosis.authEnabled ? "unknown" : "no auth")}</code>
            </p>
            {diagnosis.message !== null ? (
              <p className="mt-1 text-muted-foreground text-xs">{diagnosis.message}</p>
            ) : null}
            <PrivilegeList privileges={diagnosis.privileges} />

            {diagnosis.missing.length > 0 ? (
              <Alert variant="destructive" className="mt-3">
                <AlertTitle>Missing: {diagnosis.missing.join(", ")}</AlertTitle>
                <AlertDescription>
                  {diagnosis.ready
                    ? "The cluster can still be analyzed, but no change can be applied."
                    : "Analysis is not possible without these."}
                </AlertDescription>
              </Alert>
            ) : null}

            {diagnosis.canProvision ? (
              <div className="mt-3 rounded-md bg-muted/40 p-3">
                <p className="font-medium">
                  These credentials can create users — let Indexterity make its own?
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  A dedicated user <code>idx_…</code> is created on your cluster with the{" "}
                  <code>indexterityEngine</code> role: exactly the privileges listed above and
                  nothing else — notably <strong>no read access to your documents</strong>. The
                  admin string you pasted is used once and never stored; only the new user's string
                  is kept (encrypted). Revoke it any time with <code>db.dropUser(…)</code>.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const { name, connectionString } = credentials();
                      provision.mutate({ name, adminConnectionString: connectionString });
                    }}
                  >
                    {busy ? "Creating…" : "Create a scoped user and connect"}
                  </Button>
                  {diagnosis.ready ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => connectAsIs.mutate(credentials())}
                    >
                      Use these credentials as-is
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : diagnosis.ready ? (
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => connectAsIs.mutate(credentials())}
              >
                Connect
              </Button>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">
                Grant the missing privileges to this user, or paste credentials that can create
                users and Indexterity will provision a scoped one for you.{" "}
                <a href={CLUSTER_USER_DOCS_HREF} className="underline">
                  The exact role is here
                </a>
                .
              </p>
            )}
          </div>
        ) : null}

        {provisioned !== null ? (
          <Alert>
            <AlertTitle>
              Created scoped user <code>{provisioned.username}</code> — shown once
            </AlertTitle>
            <AlertDescription className="grid gap-1">
              <code className="break-all font-mono text-xs">{provisioned.connectionString}</code>
              <span className="text-xs">
                Stored encrypted; the admin string was not saved. To revoke access later:{" "}
                <code>db.dropUser("{provisioned.username}")</code> in the admin database.
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

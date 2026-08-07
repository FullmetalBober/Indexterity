import {
  type ConnectionDiagnosis,
  createClusterInput,
  NO_TLS_OVERRIDES,
  type PlanInfo,
  type TlsOverrides,
} from "@repo/contracts";
import { useState } from "react";
import { usage } from "~/components/app/format";
import { PrivilegeList } from "~/components/app/privilege-list";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
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

// One entry per driver option, spelled out rather than summarised: the reader is
// being asked to give up a specific protection, so the help text says which.
const TLS_BOXES: readonly { key: keyof TlsOverrides; label: string; help: string }[] = [
  {
    key: "allowInvalidCertificates",
    label: "Allow an unverified certificate",
    help: "Self-signed, or signed by a certificate authority we do not carry. The connection is still encrypted; nothing proves who is on the other end.",
  },
  {
    key: "allowInvalidHostnames",
    label: "Allow a mismatched hostname",
    help: "The certificate is valid but issued for a different name than the one being dialed — usual with an SSH tunnel or a rewritten DNS name.",
  },
  {
    key: "insecure",
    label: "Skip every certificate check",
    help: "The broadest of the three: both of the above, plus expired certificates and no revocation check. Prefer one of the narrower boxes if it is enough.",
  },
];

// Why no scoped user was offered, on a connection that is otherwise fine.
//
// Says which action is missing rather than that one is: `createUser` alone is a
// different grant from all three, and the reader is being asked to go and change
// a role on their own cluster. Silent in the one case where the answer is not
// about a grant at all — a deployment with authentication disabled has every
// privilege and still cannot enforce a dedicated user, and the diagnosis's own
// message says so.
function ProvisioningUnavailable({ diagnosis }: { diagnosis: ConnectionDiagnosis }) {
  const gaps = diagnosis.privileges.filter(
    (privilege) => privilege.tier === "PROVISION" && !privilege.granted,
  );
  if (!diagnosis.authEnabled || gaps.length === 0) return null;
  return (
    <p className="mt-3 text-muted-foreground text-xs">
      No scoped user was offered: these credentials are missing{" "}
      {gaps.map((gap, index) => (
        <span key={gap.key}>
          {index > 0 ? ", " : null}
          <code>{gap.key}</code>
        </span>
      ))}{" "}
      on <code>admin</code>. Connecting as-is stores the string you pasted (encrypted) and dials the
      cluster with it on every collect. Grant {gaps.length === 1 ? "that action" : "those actions"}{" "}
      and check again, and Indexterity will offer to create an <code>idx_…</code> user with only the
      privileges above instead — or create one yourself and connect with its string.{" "}
      <a href={CLUSTER_USER_DOCS_HREF} className="underline">
        The exact role is here
      </a>
      .
    </p>
  );
}

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
  // Which certificate checks the reader is choosing to skip. Outside the form
  // store deliberately: they are not validated fields, and the two buttons under
  // a diagnosis read them at click time the same way the credentials are read.
  const [tls, setTls] = useState<TlsOverrides>(NO_TLS_OVERRIDES);

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
    setTls(NO_TLS_OVERRIDES);
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
    onSubmit: ({ value }) =>
      check.mutate({ connectionString: value.connectionString, tlsOverrides: tls }),
  });

  // One flag over three mutations: any of them in flight means the form is
  // waiting on the api, and the second click would be about stale fields.
  const busy = check.isPending || connectAsIs.isPending || provision.isPending;

  // Read at click time rather than at render: the two buttons under a diagnosis
  // are not the form's submit, and the form store deliberately does not re-render
  // this component when a field changes.
  const credentials = () => ({ ...form.state.values, tlsOverrides: tls });

  // A diagnosis describes one exact string, and the boxes are part of the string
  // that gets checked — so moving one invalidates the answer above exactly the
  // way editing the connection string does.
  function setOverride(key: keyof TlsOverrides, value: boolean) {
    setTls((current) => ({ ...current, [key]: value }));
    setDiagnosis(null);
  }

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

        {/* Under the string, not beside it: these describe the connection the
            string makes, and each one gives up a check that TLS is otherwise
            there to perform. Refused outright unless ticked (mongo/client.ts),
            so this is the only way to connect a cluster whose certificate does
            not verify — and it stays visible on the cluster afterwards rather
            than being a decision made once and forgotten.

            Three boxes rather than one "insecure" toggle, because they are not
            the same concession: a private CA fails certificate validation with a
            perfectly correct hostname, and an SSH tunnel or a rewritten DNS name
            fails the hostname check with a genuinely valid certificate. One
            switch would make everyone give up both. */}
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">
            Certificate checks{" "}
            <span className="font-normal text-muted-foreground">
              — leave these alone unless the connection fails on the certificate
            </span>
          </legend>
          {TLS_BOXES.map((box) => (
            <div key={box.key} className="flex items-start gap-2">
              <Checkbox
                id={`tls-${box.key}`}
                checked={tls[box.key]}
                onCheckedChange={(checked) => setOverride(box.key, checked === true)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5 leading-tight">
                <Label htmlFor={`tls-${box.key}`} className="font-normal text-sm">
                  {box.label}
                </Label>
                <p className="text-muted-foreground text-xs">{box.help}</p>
              </div>
            </div>
          ))}
        </fieldset>

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
                      const { name, connectionString, tlsOverrides } = credentials();
                      provision.mutate({
                        name,
                        adminConnectionString: connectionString,
                        tlsOverrides,
                      });
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
              <>
                <Button
                  className="mt-3"
                  disabled={busy}
                  onClick={() => connectAsIs.mutate(credentials())}
                >
                  Connect
                </Button>
                {/* The branch that used to render a bare Connect button and
                    nothing else. "These credentials cannot create users" and "we
                    could not tell what they can do" were the same pixels, and
                    the safer path was never mentioned to the one reader who
                    could still take it (#86). */}
                <ProvisioningUnavailable diagnosis={diagnosis} />
              </>
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

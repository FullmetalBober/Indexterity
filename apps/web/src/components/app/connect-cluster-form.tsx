import type { ConnectionDiagnosis } from "@repo/contracts";
import { useState } from "react";
import { PrivilegeList } from "~/components/app/privilege-list";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  useCheckConnection,
  useConnectCluster,
  useProvisionCluster,
} from "~/lib/queries/mutations/cluster";

export function ConnectClusterForm() {
  const [name, setName] = useState("");
  const [connString, setConnString] = useState("");
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
    setName("");
    setConnString("");
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

  const connectAsIs = useConnectCluster(
    { name, connectionString: connString },
    { onStart, onConnected, onError: setError },
  );

  const provision = useProvisionCluster(
    { name, adminConnectionString: connString },
    { onStart, onConnected, onError: setError, onProvisioned: setProvisioned },
  );

  // One flag over three mutations: any of them in flight means the form is
  // waiting on the api, and the second click would be about stale fields.
  const busy = check.isPending || connectAsIs.isPending || provision.isPending;

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">Connect a cluster</CardTitle>
        <CardDescription>
          Paste any connection string — Indexterity checks what it can do before storing anything.
          Clusters start in read-only mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            check.mutate(connString);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="cluster-name">Name</Label>
            <Input
              id="cluster-name"
              className="w-48"
              placeholder="Production"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid min-w-72 flex-1 gap-1.5">
            <Label htmlFor="cluster-conn">Connection string</Label>
            <Input
              id="cluster-conn"
              className="font-mono"
              placeholder="mongodb://user:pass@host:27017"
              value={connString}
              onChange={(event) => {
                setConnString(event.target.value);
                setDiagnosis(null);
              }}
            />
          </div>
          <Button type="submit" disabled={busy || name.length === 0 || connString.length === 0}>
            {busy ? "Checking…" : "Check access"}
          </Button>
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
                  <Button disabled={busy} onClick={() => provision.mutate()}>
                    {busy ? "Creating…" : "Create a scoped user and connect"}
                  </Button>
                  {diagnosis.ready ? (
                    <Button variant="outline" disabled={busy} onClick={() => connectAsIs.mutate()}>
                      Use these credentials as-is
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : diagnosis.ready ? (
              <Button className="mt-3" disabled={busy} onClick={() => connectAsIs.mutate()}>
                Connect
              </Button>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">
                Grant the missing privileges to this user, or paste credentials that can create
                users and Indexterity will provision a scoped one for you. The exact role is in{" "}
                <code>docs/architecture.md</code> §10.1.
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

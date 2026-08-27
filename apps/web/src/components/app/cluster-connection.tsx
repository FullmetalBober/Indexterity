import { type ClusterEngine, canHideIndexes } from "@repo/contracts";
import { useState } from "react";
import { CONNECTION_SCHEME } from "~/components/app/connection-dialect";
import { CredentialPrivilegesPanel } from "~/components/app/credential-privileges";
import { ReauthDialog } from "~/components/app/reauth-dialog";
import { ConfirmButton } from "~/components/confirm-button";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import { useClusterPrivileges } from "~/lib/queries/cluster-privileges";
import {
  useDisconnectCluster,
  useRotateConnection,
  useSetClusterMode,
} from "~/lib/queries/mutations/cluster";

interface ClusterConnectionInfo {
  readonly id: string;
  readonly name: string;
  readonly engine: ClusterEngine;
  readonly readOnly: boolean;
  readonly provisionedUsername: string | null;
  // The engine's own removal statement(s), composed by the api (#338). Null
  // exactly when provisionedUsername is.
  readonly revokeCommand: string | null;
  readonly credentialPosture: "PROVISIONED" | "ADMIN" | "SCOPED" | null;
}

// What the stored credentials COULD do, as against what read-only mode ALLOWS
// them to. The two are different questions and the card answers both: a cluster
// can be read-only and still be held on a string that could drop a table.
//
// Null is its own case rather than folded into the narrowest one. Every cluster
// connected before the column existed reads null, and so does any rotation whose
// diagnosis failed — "we never asked" is not "scoped", and guessing here is how a
// reassuring badge gets attached to an admin string.
const POSTURE = {
  PROVISIONED: {
    label: "scoped user",
    detail:
      "Indexterity created this user itself, so its ceiling is known exactly: the privileges it needs and nothing more.",
  },
  ADMIN: {
    label: "admin credentials",
    detail:
      "These credentials could create users when they were stored, so they can do more than manage indexes. A narrower string can be swapped in by rotating.",
  },
  SCOPED: {
    label: "scoped credentials",
    detail:
      "A pasted string that cannot create users. Narrower than admin, though its exact grants are yours rather than ours to state.",
  },
} as const;

// Whether this cluster's stored credentials break a rule the org has since turned
// on (#313).
//
// It exists because switching the setting on cannot reach backwards: the admin
// string is already sealed, and un-storing it is not an operation. So the cluster
// keeps collecting — an org must never have to choose between its policy and its
// analysis — and the card says the cluster is out of policy and points at the one
// thing that fixes it, which is a rotation.
//
// `PROVISIONED` and `SCOPED` are in policy. `null` is deliberately NOT: it means
// nobody ever asked how privileged these credentials are, and a rule that says
// "no credentials broader than the engine needs" cannot be satisfied by a cluster
// we cannot describe. Rendered as its own sentence rather than as a violation,
// because the remedy differs — rotating RECORDS the posture, and may well record
// that it was fine all along.
function policyState(
  posture: ClusterConnectionInfo["credentialPosture"],
  required: boolean,
): "ok" | "violates" | "unknown" {
  if (!required) return "ok";
  if (posture === "ADMIN") return "violates";
  if (posture === null) return "unknown";
  return "ok";
}

// The things you can do TO a cluster: change what the engine is allowed to do,
// see and change the credentials it does it with, and stop.
//
// They used to sit in the bar above the dashboard, one row from the numbers they
// would invalidate — "Disconnect" was two buttons along from a cluster selector,
// and both are one click. They are a page you have to mean to open now, which is
// the whole difference between a control and an accident.
export function ClusterConnection({
  cluster,
  requireLeastPrivilege = false,
}: {
  cluster: ClusterConnectionInfo;
  // Off unless the org read says otherwise, which is also what a page rendering
  // before that read lands should assume: marking a cluster out of policy on a
  // rule we have not confirmed is on is the one direction of this that is a lie.
  requireLeastPrivilege?: boolean;
}) {
  // Three sentences on this card promise a hide, and one engine has none — so
  // they are per-engine rather than per-product. From the contract's table, not
  // from a guess here, and the api holds that table to its own adapters.
  const canHide = canHideIndexes(cluster.engine);
  const posture = cluster.credentialPosture === null ? null : POSTURE[cluster.credentialPosture];
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateString, setRotateString] = useState("");
  // Lazy on purpose (#313): the read behind this dials the customer's cluster, so
  // it fires when a reader asks rather than on every settings page view. Once
  // opened it stays enabled, so collapsing and reopening reads the cache instead
  // of dialling again.
  const [privilegesOpen, setPrivilegesOpen] = useState(false);
  const [privilegesAsked, setPrivilegesAsked] = useState(false);
  const privileges = useClusterPrivileges(cluster.id, privilegesAsked);
  const policy = policyState(cluster.credentialPosture, requireLeastPrivilege);
  // Set when the api answered SESSION_NOT_FRESH (#52): the retry the re-auth
  // dialog fires once the password proves the owner is still at the keyboard.
  // One slot for all three actions — only one refusal can be on screen.
  const [staleRetry, setStaleRetry] = useState<(() => void) | null>(null);
  const onStale = (retry: () => void) => setStaleRetry(() => retry);

  const toggleMode = useSetClusterMode(cluster.id, { onStale });
  const disconnect = useDisconnectCluster(cluster.id, { onStale });
  const rotate = useRotateConnection(cluster.id, {
    onRotated: () => {
      setRotateOpen(false);
      setRotateString("");
    },
    onStale,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connection</CardTitle>
        <CardDescription>
          What the engine may do on this cluster, the credentials it does it with, and how to stop.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          {cluster.readOnly ? (
            <ConfirmButton
              trigger={<Button variant="outline">Go live</Button>}
              title="Enable live mode?"
              description={`The engine will be allowed to modify indexes on "${cluster.name}" — ${
                canHide ? "hide, drop and build" : "drop and build"
              }. Drops still pass the observe window and the regression gate first.`}
              confirmLabel="Go live"
              onConfirm={() => toggleMode.mutate(false)}
            />
          ) : (
            <Button variant="outline" onClick={() => toggleMode.mutate(true)}>
              Make read-only
            </Button>
          )}
          <p className="text-muted-foreground text-sm">
            {cluster.readOnly
              ? "Read-only: recommendations are proposed, nothing is applied."
              : canHide
                ? "Live: the engine may hide, drop and build indexes here."
                : "Live: the engine may drop and build indexes here."}
          </p>
        </div>

        {/* Beside the mode rather than under the connection string: the two are
            one question a reader asks together — what is allowed here, and what
            could these credentials do if something went wrong. */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Badge variant={cluster.credentialPosture === "ADMIN" ? "secondary" : "outline"}>
            {posture?.label ?? "posture not recorded"}
          </Badge>
          <p className="text-muted-foreground text-sm">
            {posture?.detail ??
              "This cluster was connected before Indexterity recorded how privileged its credentials are. Rotating the connection string records it."}
          </p>
        </div>

        {/* Under the badge it qualifies, and only when the org has the rule on.
            A cluster sealed before the rule existed is not a fault of the person
            reading this, so it says what is true and what fixes it — and says
            nothing about analysis stopping, because it does not. */}
        {policy === "violates" ? (
          <Alert>
            <AlertTitle>Out of policy for this organization</AlertTitle>
            <AlertDescription>
              This organization requires credentials no broader than the engine needs, and these
              were stored before that was switched on — they can create users. Analysis keeps
              running; nothing here has stopped. Rotate to a narrower string below, or disconnect
              and reconnect letting Indexterity provision a scoped user.
            </AlertDescription>
          </Alert>
        ) : policy === "unknown" ? (
          <Alert>
            <AlertTitle>Posture unknown, and this organization requires least privilege</AlertTitle>
            <AlertDescription>
              Nobody ever recorded how privileged these credentials are, so this cluster cannot be
              said to meet the rule. Rotating the string records it — and may well record that it
              was already fine.
            </AlertDescription>
          </Alert>
        ) : null}

        <Separator />

        {/* Above the rotation, below the badge: it is the detail behind the
            badge, and the action it most often leads to is the form underneath.
            The badge says how privileged; this says which privileges. */}
        <CredentialPrivilegesPanel
          open={privilegesOpen}
          onOpen={() => {
            setPrivilegesOpen(!privilegesOpen);
            setPrivilegesAsked(true);
          }}
          read={privileges}
        />

        <Separator />

        <div>
          <Button variant="outline" size="sm" onClick={() => setRotateOpen(!rotateOpen)}>
            Rotate string
          </Button>
          <p className="mt-2 text-muted-foreground text-sm">
            Verified before it is stored, so a typo cannot brick the cluster — and the history
            survives, unlike disconnecting and reconnecting.
          </p>
          {rotateOpen ? (
            <form
              className="mt-3 flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                rotate.mutate(rotateString);
              }}
            >
              <Input
                aria-label="New connection string"
                className="min-w-72 flex-1 font-mono text-xs"
                // The engine of the cluster in front of the reader, not
                // MongoDB's. This said `mongodb://` on a PostgreSQL cluster,
                // which is the field telling somebody the wrong thing about
                // their own database at the moment they are pasting a
                // credential into it.
                placeholder={`new ${CONNECTION_SCHEME[cluster.engine]} connection string (verified before stored)`}
                value={rotateString}
                onChange={(event) => setRotateString(event.target.value)}
              />
              <Button type="submit" disabled={rotateString.length === 0}>
                Save
              </Button>
            </form>
          ) : null}
        </div>

        <Separator />

        <div>
          <ConfirmButton
            destructive
            trigger={
              <Button variant="ghost" className="text-destructive">
                Disconnect
              </Button>
            }
            title={`Disconnect "${cluster.name}"?`}
            description={
              <>
                <p>
                  All collected snapshots, recommendations, ROI history and the audit trail are
                  deleted.{" "}
                  {canHide
                    ? "Indexes still hidden in an observe window are restored first."
                    : "No index is left changed — nothing was hidden to restore."}
                </p>
                {cluster.revokeCommand === null ? null : (
                  <p>
                    The scoped user stays on your cluster — revoke it afterwards:
                    {/* whitespace-pre-wrap, not break-all: PostgreSQL and SQL Server
                        both need one statement per provisioned database and the
                        order matters, so the line breaks are the meaning. */}
                    <code className="mt-1 block whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                      {cluster.revokeCommand}
                    </code>
                  </p>
                )}
              </>
            }
            confirmLabel="Disconnect"
            onConfirm={() => disconnect.mutate()}
          />
          <p className="mt-2 text-muted-foreground text-sm">
            Everything collected about this cluster is deleted. It cannot be undone.
          </p>
        </div>

        <ReauthDialog retry={staleRetry} onDone={() => setStaleRetry(null)} />
      </CardContent>
    </Card>
  );
}

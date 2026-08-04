import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmButton } from "~/components/confirm-button";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMounted } from "~/lib/hydration";
import {
  useDisconnectCluster,
  useRotateConnection,
  useSetClusterMode,
} from "~/lib/queries/mutations/cluster";

interface ClusterOption {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly provisionedUsername: string | null;
  readonly lastCollectedAt: string | null;
}

// Anything older than this means the numbers on screen predate a gap in
// collection — say so rather than letting them read as current.
const STALE_AFTER_HOURS = 48;

function staleness(lastCollectedAt: string | null): string | null {
  if (lastCollectedAt === null) return "never collected";
  const hours = (Date.now() - new Date(lastCollectedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < STALE_AFTER_HOURS) return null;
  const days = Math.floor(hours / 24);
  return days >= 1
    ? `last collected ${days} day${days === 1 ? "" : "s"} ago`
    : `last collected ${Math.floor(hours)}h ago`;
}

export function ClusterBar({
  cluster,
  clusters,
}: {
  cluster: ClusterOption;
  clusters: readonly ClusterOption[];
}) {
  const navigate = useNavigate();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateString, setRotateString] = useState("");
  // "How long since we last collected" depends on the reader's clock, so it
  // resolves after hydration rather than differing between the two renders.
  const stale = useMounted() ? staleness(cluster.lastCollectedAt) : null;

  const toggleMode = useSetClusterMode(cluster.id);
  const disconnect = useDisconnectCluster(cluster.id);
  const rotate = useRotateConnection(cluster.id, {
    onRotated: () => {
      setRotateOpen(false);
      setRotateString("");
    },
  });

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {clusters.length > 1 ? (
        <Select
          value={cluster.id}
          onValueChange={(value) => {
            void navigate({ to: "/app", search: { cluster: value } });
          }}
        >
          <SelectTrigger size="sm" className="w-55" aria-label="Select cluster">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {clusters.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-muted-foreground">{cluster.name}</span>
      )}
      <Badge variant={cluster.readOnly ? "secondary" : "destructive"}>
        {cluster.readOnly ? "read-only" : "live"}
      </Badge>
      {cluster.provisionedUsername !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-mono">
              {cluster.provisionedUsername}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Indexterity runs as its own least-privilege user here — it cannot read your documents
          </TooltipContent>
        </Tooltip>
      ) : null}
      {stale !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              ⚠ {stale}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            These figures predate a gap in collection. Usage-based drop recommendations are withheld
            until the history is continuous again.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {cluster.readOnly ? (
        <ConfirmButton
          trigger={
            <Button variant="outline" size="sm">
              Go live
            </Button>
          }
          title="Enable live mode?"
          description={`The engine will be allowed to modify indexes on "${cluster.name}" — hide, drop and build. Drops still pass the observe window and the regression gate first.`}
          confirmLabel="Go live"
          onConfirm={() => toggleMode.mutate(false)}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => toggleMode.mutate(true)}>
          Make read-only
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => setRotateOpen(!rotateOpen)}>
        Rotate string
      </Button>
      <ConfirmButton
        destructive
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive">
            Disconnect
          </Button>
        }
        title={`Disconnect "${cluster.name}"?`}
        description={
          <>
            <p>
              All collected snapshots, recommendations, ROI history and the audit trail are deleted.
              Indexes still hidden in an observe window are restored first.
            </p>
            {cluster.provisionedUsername === null ? null : (
              <p>
                The scoped user stays on your cluster — revoke it afterwards:
                <code className="mt-1 block break-all rounded bg-muted p-2 font-mono text-xs">
                  db.getSiblingDB("admin").dropUser("{cluster.provisionedUsername}")
                </code>
              </p>
            )}
          </>
        }
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutate()}
      />
      {rotateOpen ? (
        <form
          className="flex w-full gap-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            rotate.mutate(rotateString);
          }}
        >
          <Input
            className="min-w-72 flex-1 font-mono text-xs"
            placeholder="new mongodb:// connection string (verified before stored)"
            value={rotateString}
            onChange={(event) => setRotateString(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={rotateString.length === 0}>
            Save
          </Button>
        </form>
      ) : null}
    </div>
  );
}

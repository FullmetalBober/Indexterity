import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useSetClusterTunnel } from "~/lib/queries/mutations/tunnels";
import { useTunnels } from "~/lib/queries/tunnels";

// How this cluster is reached: straight out of our egress, or through one of
// the org's WireGuard tunnels (#353).
//
// On the cluster's settings page rather than the connect form, because it is a
// property of the ROUTE and not of the credentials — an owner changes it when
// the database moves behind a VPN, without rotating anything.

const DIRECT = "__direct__";

export function ClusterTunnel({
  clusterId,
  tunnelId,
  canEdit,
}: {
  clusterId: string;
  tunnelId: string | null;
  canEdit: boolean;
}) {
  const tunnels = useTunnels();
  const set = useSetClusterTunnel();
  const selected = tunnels.data.find((tunnel) => tunnel.id === tunnelId) ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>How this cluster is reached</CardTitle>
        <CardDescription>
          {tunnelId === null
            ? "Dialled directly. Choose a tunnel if this database has no public endpoint."
            : "Dialled through a VPN tunnel. TLS is still required, and cloud metadata is still refused."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {tunnels.pending ? null : tunnels.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No tunnels registered.{" "}
            <Link to="/app/settings/tunnels" className="underline">
              Add one
            </Link>{" "}
            to reach a database that has no public endpoint.
          </p>
        ) : (
          <Select
            value={tunnelId ?? DIRECT}
            disabled={!canEdit || set.isPending}
            onValueChange={(value) =>
              set.mutate({ clusterId, tunnelId: value === DIRECT ? null : value })
            }
          >
            <SelectTrigger className="w-full sm:w-96">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DIRECT}>Directly, from our own network</SelectItem>
              {tunnels.data.map((tunnel) => (
                <SelectItem key={tunnel.id} value={tunnel.id}>
                  {tunnel.name} — {tunnel.endpoint}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* A down tunnel is a condition of the TUNNEL. Saying so here stops it
            being read as a broken cluster, which is the wrong thing to go and
            investigate. */}
        {selected !== null && selected.health === "DOWN" ? (
          <p className="text-destructive text-sm">
            This tunnel's gateway is not answering, so this cluster is currently unreachable — not
            broken. Collection resumes when the handshake does.
          </p>
        ) : null}
        {selected !== null && selected.dns.length === 0 ? (
          <p className="text-amber-600 text-sm">
            This tunnel carries no DNS, so this cluster's connection string has to name IP addresses
            rather than hostnames.
          </p>
        ) : null}
        {!canEdit ? (
          <p className="text-muted-foreground text-xs">Only an owner can change this.</p>
        ) : null}
        {tunnels.failed ? (
          <Button variant="outline" size="sm" onClick={tunnels.retry}>
            Retry loading tunnels
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

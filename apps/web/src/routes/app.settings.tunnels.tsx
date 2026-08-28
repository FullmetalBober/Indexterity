// WireGuard tunnels for the org (#353): how a database with no public endpoint
// is reached.
//
// Under Settings rather than on a cluster, because one peering commonly reaches
// several clusters on the same network — a config per cluster would mean
// rotating a key in as many places as there are databases behind it.
import { createFileRoute } from "@tanstack/react-router";
import { TunnelList } from "~/components/app/tunnel-list";
import { useOrg } from "~/lib/queries/shell";
import { useTunnels } from "~/lib/queries/tunnels";

export const Route = createFileRoute("/app/settings/tunnels")({
  head: () => ({ meta: [{ title: "VPN tunnels — Indexterity" }] }),
  component: TunnelsPage,
});

function TunnelsPage() {
  const tunnels = useTunnels();
  const org = useOrg();
  // Registering a peering decides where the control plane opens sockets, so the
  // form is owner-only — the list is not, because knowing a VPN exists is not
  // sensitive and the secret half never leaves the api.
  return <TunnelList tunnels={tunnels} canEdit={org?.role === "owner"} />;
}

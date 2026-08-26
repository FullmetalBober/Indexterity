import type { TunnelView } from "@repo/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Empty } from "~/components/ui/empty";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { useCreateTunnel, useDeleteTunnel } from "~/lib/queries/mutations/tunnels";
import type { Read } from "~/lib/queries/read";

// Register a WireGuard peering by pasting the wg0.conf, and see whether it is
// currently up.
//
// One textarea rather than a field per directive, deliberately: a wg0.conf is
// what a VPN admin exports and what an owner can paste without transcribing.
// The api parses it strictly and its refusals name the exact directive, so
// splitting the form would only move that validation somewhere worse.
//
// The [Interface] PrivateKey never comes back from the api. Nothing on this
// screen can show it, which is the point — it is a credential of the same
// weight as a connection string.

const HEALTH: Record<TunnelView["health"], { label: string; tone: string; title: string }> = {
  UP: { label: "Up", tone: "text-emerald-600", title: "Handshake current" },
  HANDSHAKING: {
    label: "Connecting",
    tone: "text-amber-600",
    title: "Negotiating with the gateway",
  },
  DOWN: {
    label: "Down",
    tone: "text-destructive",
    title: "The gateway is not answering — clusters behind this are unreachable, not broken",
  },
  // Not a fault. Tunnels come up on first use, so this is the normal state of a
  // healthy tunnel nobody has collected through yet, and drawing it as a
  // problem would teach people to ignore the indicator.
  IDLE: {
    label: "Idle",
    tone: "text-muted-foreground",
    title: "Not in use since the server started",
  },
};

function age(seconds: number | null): string {
  if (seconds === null) return "no handshake yet";
  if (seconds < 90) return `handshake ${Math.round(seconds)}s ago`;
  return `handshake ${Math.round(seconds / 60)}m ago`;
}

export function TunnelList({
  tunnels,
  canEdit,
}: {
  tunnels: Read<TunnelView[]>;
  canEdit: boolean;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Reaching a database over a VPN</CardTitle>
          <CardDescription>
            A cluster with no public endpoint can be reached by registering the WireGuard peer its
            network already uses. Indexterity terminates the tunnel itself — nothing extra runs on
            your side.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {tunnels.pending ? (
            <Skeleton className="h-20 w-full" />
          ) : tunnels.failed ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">Could not load your tunnels.</p>
              <Button variant="outline" size="sm" onClick={tunnels.retry}>
                Retry
              </Button>
            </div>
          ) : tunnels.data.length === 0 ? (
            <Empty>No tunnels yet. Paste a WireGuard config below to add one.</Empty>
          ) : (
            <ul className="divide-y">
              {tunnels.data.map((tunnel) => (
                <TunnelRow key={tunnel.id} tunnel={tunnel} canEdit={canEdit} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {canEdit ? <CreateTunnel /> : null}
    </div>
  );
}

function TunnelRow({ tunnel, canEdit }: { tunnel: TunnelView; canEdit: boolean }) {
  const remove = useDeleteTunnel();
  const health = HEALTH[tunnel.health];
  const inUse = tunnel.clusterCount > 0;

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 py-4">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{tunnel.name}</span>
          <span className={`text-xs ${health.tone}`} title={health.title}>
            ● {health.label}
          </span>
          <span className="text-muted-foreground text-xs">{age(tunnel.handshakeAgeSeconds)}</span>
        </div>
        <p className="text-muted-foreground text-sm">
          {tunnel.endpoint === "" ? (
            // A row whose config cannot be unsealed — a master key rotated
            // without its predecessor. It stays listed so it can be deleted.
            <span className="text-destructive">This tunnel's config cannot be read.</span>
          ) : (
            <>
              gateway <code>{tunnel.endpoint}</code> · reaches{" "}
              <code>{tunnel.allowedIps.join(", ")}</code>
            </>
          )}
        </p>
        {tunnel.dns.length === 0 && tunnel.endpoint !== "" ? (
          // Worth saying out loud: without a resolver inside the tunnel, a
          // connection string naming a host fails as "unreachable", which reads
          // like a firewall problem and sends people looking in the wrong place.
          <p className="text-amber-600 text-xs">
            No DNS in this config — clusters behind it must be addressed by IP.
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {inUse
            ? `${tunnel.clusterCount} cluster${tunnel.clusterCount === 1 ? "" : "s"} reached through this`
            : "No clusters use this yet"}
        </p>
      </div>
      {canEdit ? (
        <Button
          variant="outline"
          size="sm"
          // Disabled rather than hidden, with the reason: a delete that is
          // refused after the click teaches nothing about what to do instead.
          disabled={inUse || remove.isPending}
          title={inUse ? "Point its clusters somewhere else first" : undefined}
          onClick={() => remove.mutate(tunnel.id)}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}

function CreateTunnel() {
  const [name, setName] = useState("");
  const [config, setConfig] = useState("");
  const create = useCreateTunnel();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), config },
      {
        onSuccess: () => {
          setName("");
          setConfig("");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a tunnel</CardTitle>
        <CardDescription>
          Paste the whole <code>wg0.conf</code> your VPN gave you. The private key in it is
          encrypted before it is stored and is never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="tunnel-name">Name</FieldLabel>
            <Input
              id="tunnel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production VPC"
              maxLength={80}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tunnel-config">WireGuard config</FieldLabel>
            <textarea
              id="tunnel-config"
              value={config}
              onChange={(event) => setConfig(event.target.value)}
              className="border-input bg-transparent placeholder:text-muted-foreground focus-visible:ring-ring/50 min-h-55 w-full rounded-md border px-3 py-2 font-mono text-sm shadow-xs focus-visible:ring-3 focus-visible:outline-none"
              placeholder={
                "[Interface]\nPrivateKey = ...\nAddress = 10.9.0.2/32\nDNS = 10.9.0.1\n\n[Peer]\nPublicKey = ...\nAllowedIPs = 10.0.0.0/8\nEndpoint = vpn.example.com:51820"
              }
              spellCheck={false}
              required
            />
          </Field>
          <Button type="submit" disabled={create.isPending || name.trim() === "" || config === ""}>
            {create.isPending ? "Checking…" : "Register tunnel"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

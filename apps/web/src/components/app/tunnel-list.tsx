import { createTunnelInput, type TunnelTestResult, type TunnelView } from "@repo/contracts";
import { useState } from "react";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Empty } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import {
  useCreateTunnel,
  useDeleteTunnel,
  useTestTunnel,
  useUpdateTunnel,
} from "~/lib/queries/mutations/tunnels";
import type { Tunnels } from "~/lib/queries/tunnels";

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
// weight as a connection string. That decides the shape of the edit form: a
// rename is an ordinary prefilled field, and changing the config means pasting
// a whole new file, because there is nothing here to amend.

// The api's own rules, field by field, rather than a second copy of them: the
// same schema createTunnel validates against on the way in, so a paste refused
// here is refused for the reason it would have been refused there.
const NAME = createTunnelInput.shape.name;
const CONFIG = createTunnelInput.shape.config;

// On an edit, an empty box is the only way to say "keep the config that is
// stored" — there is nothing to prefill it with, since the PrivateKey in it never
// comes back from the api. Anything else goes through the rule above.
function optionalConfig({ value }: { value: string }): string | undefined {
  if (value.trim() === "") return undefined;
  const result = CONFIG.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

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

// The feature is OFF, not broken: a deployment with no tunnel service is a
// supported configuration. So this says what is true and who can change it,
// rather than reading as a fault the owner should be chasing.
//
// It names the setting because on a self-hosted install the person reading this
// is usually the person who sets it — and on a hosted one it tells them what to
// ask for, which beats a sentence that only says no.
function TunnelsOff() {
  return (
    <Alert>
      <AlertTitle>VPN tunnels are turned off on this deployment</AlertTitle>
      <AlertDescription>
        Reaching a database over a VPN needs the tunnel service running beside the api. Whoever
        operates this install turns it on by setting <code>TUNNEL_PORT</code>. Anything already
        registered stays listed and starts working again the moment it is set.
      </AlertDescription>
    </Alert>
  );
}

export function TunnelList({ tunnels, canEdit }: { tunnels: Tunnels; canEdit: boolean }) {
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
          {/* Only once the answer is in. `enabled` defaults to true while the
              request is in flight precisely so this cannot flash. */}
          {!tunnels.pending && !tunnels.failed && !tunnels.enabled ? <TunnelsOff /> : null}
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
            <Empty>
              {tunnels.enabled
                ? "No tunnels yet. Paste a WireGuard config below to add one."
                : "No tunnels registered."}
            </Empty>
          ) : (
            <ul className="divide-y">
              {tunnels.data.map((tunnel) => (
                <TunnelRow key={tunnel.id} tunnel={tunnel} canEdit={canEdit} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {/* No form when the feature is off: registering a peering nothing can bring
          up is exactly the "form whose every submission fails at the last step"
          this state exists to avoid. The api still accepts a create, so a row
          registered before the setting was removed is not a special case. */}
      {canEdit && tunnels.enabled ? <CreateTunnel /> : null}
    </div>
  );
}

function TunnelRow({ tunnel, canEdit }: { tunnel: TunnelView; canEdit: boolean }) {
  const remove = useDeleteTunnel();
  const test = useTestTunnel();
  const [editing, setEditing] = useState(false);
  const health = HEALTH[tunnel.health];
  const inUse = tunnel.clusterCount > 0;
  const unreadable = tunnel.endpoint === "";

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
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
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              // Nothing else on this row is evidence: every field of it, health
              // included, is derived from a file that was parsed. This is the one
              // control that asks the gateway.
              disabled={test.isPending || unreadable}
              title={
                unreadable
                  ? "There is no config to test"
                  : "Negotiate a handshake with the gateway now"
              }
              onClick={() => test.mutate(tunnel.id)}
            >
              {test.isPending ? "Testing…" : "Test"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing((open) => !open)}>
              {editing ? "Cancel" : "Edit"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              // Disabled rather than hidden, with the reason: a delete that is
              // refused after the click teaches nothing about what to do instead.
              disabled={inUse || remove.isPending}
              title={inUse ? "Point its clusters somewhere else first" : undefined}
              onClick={() => remove.mutate(tunnel.id)}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </div>
        ) : null}
      </div>
      <Verdict pending={test.isPending} result={test.data} />
      {editing ? <EditTunnel tunnel={tunnel} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}

// The result of the last test, kept on the row rather than only in a toast: a
// toast that has faded is no use to somebody who is now editing the config it
// was about.
function Verdict({ pending, result }: { pending: boolean; result: TunnelTestResult | undefined }) {
  if (pending) {
    return (
      <p className="text-muted-foreground text-sm">Negotiating a handshake with the gateway…</p>
    );
  }
  if (result === undefined) return null;
  if (result.reachable) {
    return (
      <p className="text-sm text-emerald-600">
        The gateway answered. Databases behind this tunnel are reachable.
      </p>
    );
  }
  return (
    <p className="text-destructive text-sm">
      {result.error ??
        // No cause to report: silence is what an endpoint that is not there, a
        // UDP port a firewall drops and a PublicKey the gateway does not know
        // all look like from our side, so the three are listed rather than
        // guessed between.
        "No answer from the gateway. Check its Endpoint, that the UDP port is open to us, and that the PublicKey is the one your VPN expects."}
      {result.health === "HANDSHAKING" ? " Still retrying in the background." : null}
    </p>
  );
}

function EditTunnel({ tunnel, onDone }: { tunnel: TunnelView; onDone: () => void }) {
  const update = useUpdateTunnel();
  const form = useAppForm({
    defaultValues: { name: tunnel.name, config: "" },
    onSubmit: ({ value }) => {
      const name = value.name.trim();
      // Only what changed is sent, which is also why an empty config box is not
      // an error: it means "leave the stored one alone".
      update.mutate(
        {
          tunnelId: tunnel.id,
          ...(name === tunnel.name ? {} : { name }),
          ...(value.config.trim() === "" ? {} : { config: value.config }),
        },
        { onSuccess: onDone },
      );
    },
  });

  return (
    <form
      className="bg-muted/40 space-y-4 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.AppField name="name" validators={{ onChange: NAME }}>
        {(field) => <field.TextField label="Name" maxLength={80} />}
      </form.AppField>
      <form.AppField name="config" validators={{ onChange: optionalConfig }}>
        {(field) => (
          <field.TextareaField
            label="Replace the WireGuard config"
            className="min-h-40"
            placeholder={CONFIG_PLACEHOLDER}
            description="Empty keeps the stored config. Pasting a new wg0.conf replaces it whole — which is how a rotated key or a moved gateway lands."
          />
        )}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.config.trim() !== ""}>
        {(replaced) =>
          replaced ? (
            // Said before the click, not after: an owner replacing a config while
            // clusters are collecting through the tunnel deserves to know the
            // peering goes down for a moment.
            <p className="text-amber-600 text-xs">
              Saving this drops the live peering. It comes back up on the next collect, or as soon
              as you press Test.
            </p>
          ) : null
        }
      </form.Subscribe>
      <div className="flex items-center gap-2">
        <form.Subscribe selector={(state) => state.values}>
          {(values) => (
            <form.AppForm>
              <form.SubmitButton
                pending={update.isPending}
                // Nothing changed is the one reason to grey this out — the api
                // refuses a patch with neither field, and rightly. NOT gated on
                // validity: handleSubmit refuses an invalid form and touches the
                // fields on the way, which is what makes the errors appear.
                disabled={values.name.trim() === tunnel.name && values.config.trim() === ""}
              >
                {update.isPending ? "Saving…" : "Save changes"}
              </form.SubmitButton>
            </form.AppForm>
          )}
        </form.Subscribe>
        <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CreateTunnel() {
  const create = useCreateTunnel();
  const form = useAppForm({
    defaultValues: { name: "", config: "" },
    onSubmit: ({ value, formApi }) =>
      create.mutate(
        { name: value.name.trim(), config: value.config },
        // Cleared only on success, so a refusal leaves the paste in the box for
        // the owner to fix rather than making them fetch the file again.
        { onSuccess: () => formApi.reset() },
      ),
  });

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
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="name" validators={{ onChange: NAME }}>
            {(field) => (
              <field.TextField label="Name" placeholder="Production VPC" maxLength={80} />
            )}
          </form.AppField>
          <form.AppField name="config" validators={{ onChange: CONFIG }}>
            {(field) => (
              <field.TextareaField
                label="WireGuard config"
                className="min-h-55"
                placeholder={CONFIG_PLACEHOLDER}
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton pending={create.isPending}>
              {create.isPending ? "Checking…" : "Register tunnel"}
            </form.SubmitButton>
          </form.AppForm>
        </form>
      </CardContent>
    </Card>
  );
}

const CONFIG_PLACEHOLDER = [
  "[Interface]",
  "PrivateKey = ...",
  "Address = 10.9.0.2/32",
  "DNS = 10.9.0.1",
  "",
  "[Peer]",
  "PublicKey = ...",
  "AllowedIPs = 10.0.0.0/8",
  "Endpoint = vpn.example.com:51820",
].join("\n");

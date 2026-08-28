import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { masterKeyBytesFor } from "../src/config/env";
import {
  clusters,
  createDatabase,
  envKeyProvider,
  eq,
  inArray,
  organizations,
  seal,
  user,
} from "../src/db";
import {
  api,
  authPost,
  databaseUrl,
  type Session,
  signUp,
  startApi,
  startTunnelService,
  stopApi,
  stopTunnelService,
  TUNNEL_PORT,
} from "./helpers";

// The tunnel routes end to end (#353): register, edit, test, remove — with the
// tenancy and role refusals that make them safe to expose, and the trail row
// each act leaves, read back through the screen's own endpoint rather than the
// table it writes to.
//
// No real gateway is involved, on purpose. The endpoint points at a loopback
// port nothing listens on, so what this suite proves about the network is the
// honest half: a tunnel comes up, gets asked, and reports silence as silence.
// That a handshake actually COMPLETES cannot be faked here. It is proven against
// a kernel WireGuard peer by hand (D111 records the run), and the layer between
// this suite and the binary — the verdict this api gives a dial, and what a probe
// concludes — is unit-tested in src/tunnel/child.test.ts against a stub that
// speaks the protocol and no WireGuard at all.
//
// Mongo-free and dial-free, so this costs nothing from the dial budget.

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...value };
  }
  throw new Error(`expected an object body, got ${JSON.stringify(value)}`);
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${typeof value}`);
  return value;
}

// Real base64 keys, as a wg0.conf carries them — the parser decodes both and
// checks their length, so placeholders would be refused before any route ran.
const PRIVATE_KEY = "6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8=";
const PEER_PUBLIC_KEY = "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=";

// A loopback port nothing answers on. ALLOW_PRIVATE_CLUSTER_TARGETS is on for
// this suite (helpers.ts), which is what lets the network guard admit it — the
// same allowance a self-hosted install gives its own VPC.
const SILENT_GATEWAY = "127.0.0.1:51999";

function conf(options: { endpoint?: string; allowedIps?: string; dns?: boolean } = {}): string {
  return [
    "[Interface]",
    `PrivateKey = ${PRIVATE_KEY}`,
    "Address = 10.9.0.2/32",
    ...(options.dns === false ? [] : ["DNS = 10.9.0.1"]),
    "",
    "[Peer]",
    `PublicKey = ${PEER_PUBLIC_KEY}`,
    `AllowedIPs = ${options.allowedIps ?? "10.0.0.0/8"}`,
    `Endpoint = ${options.endpoint ?? SILENT_GATEWAY}`,
  ].join("\n");
}

// `{ enabled, tunnels }` rather than a bare array since the feature can be off:
// the rows still come back, and the flag is what the dashboard reads to say so.
async function tunnels(session: Session): Promise<Record<string, unknown>[]> {
  return asArray(asRecord(await (await api("/tunnels", session)).json()).tunnels).map(asRecord);
}

// Whether this deployment reports a tunnel service at all. The suite runs one, so
// this is `true` — asserted rather than assumed, because every tunnel test below
// depends on it and a false here would explain all of them at once.
async function tunnelsEnabled(session: Session): Promise<unknown> {
  return asRecord(await (await api("/tunnels", session)).json()).enabled;
}

async function trail(session: Session, event: string): Promise<Record<string, unknown>[]> {
  const res = await api(`/security-events?event=${event}`, session);
  expect(res.status).toBe(200);
  return asArray(asRecord(await res.json()).events).map(asRecord);
}

let server: ChildProcess;
let tunnelService: ChildProcess;
let db: ReturnType<typeof createDatabase>;
let owner: Session;
let member: Session;
let outsider: Session;
let tunnelId: string;

const createdEmails: string[] = [];
const createdOrgIds: string[] = [];

beforeAll(async () => {
  // The service first: the api is handed its URL, and a peering cannot come up
  // without something answering on it.
  tunnelService = await startTunnelService();
  server = await startApi({ TUNNEL_PORT: String(TUNNEL_PORT) });
  db = createDatabase(databaseUrl(), 2);

  owner = await signUp("tunnel-owner");
  createdEmails.push(owner.email);
  createdOrgIds.push(asString(asRecord(await (await api("/org", owner)).json()).id));

  outsider = await signUp("tunnel-outsider");
  createdEmails.push(outsider.email);
  createdOrgIds.push(asString(asRecord(await (await api("/org", outsider)).json()).id));

  // A member of the owner's org: reads are theirs, writes are not.
  member = await signUp("tunnel-member");
  createdEmails.push(member.email);
  createdOrgIds.push(asString(asRecord(await (await api("/org", member)).json()).id));
  const invite = await authPost("/organization/invite-member", owner, {
    email: member.email,
    role: "member",
  });
  expect(invite.status).toBe(200);
  const accept = await authPost("/organization/accept-invitation", member, {
    invitationId: asString(asRecord(await invite.json()).id),
  });
  expect(accept.status).toBe(200);
});

afterAll(async () => {
  for (const id of createdOrgIds) {
    await db
      .delete(organizations)
      .where(eq(organizations.id, id))
      .catch(() => {});
  }
  if (createdEmails.length > 0) {
    await db
      .delete(user)
      .where(inArray(user.email, createdEmails))
      .catch(() => {});
  }
  await db.$client.end();
  await stopApi(server);
  await stopTunnelService(tunnelService);
});

describe("the feature's availability", () => {
  // Every test below depends on this being true, and a deployment with no tunnel
  // service is a supported state that reports itself — so if this is false, it
  // explains all of them at once rather than each failing on its own terms.
  it("reports itself enabled, because this suite runs a tunnel service", async () => {
    expect(await tunnelsEnabled(owner)).toBe(true);
  });
});

describe("registering a tunnel", () => {
  it("derives the whole view from the pasted config", async () => {
    const res = await api("/tunnels", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Production VPC", config: conf() }),
    });
    expect(res.status).toBe(200);
    const tunnel = asRecord(await res.json());
    tunnelId = asString(tunnel.id);

    expect(tunnel).toMatchObject({
      name: "Production VPC",
      endpoint: SILENT_GATEWAY,
      allowedIps: ["10.0.0.0/8"],
      dns: ["10.9.0.1"],
      clusterCount: 0,
      // Nothing has needed it yet, and that is not a fault: tunnels come up on
      // first use, so a healthy new one is IDLE with no handshake behind it.
      health: "IDLE",
      handshakeAgeSeconds: null,
    });
  });

  it("refuses a config the parser cannot accept, and names the directive", async () => {
    const res = await api("/tunnels", owner, {
      method: "POST",
      body: JSON.stringify({
        name: "No endpoint",
        config: conf().replace(`Endpoint = ${SILENT_GATEWAY}`, ""),
      }),
    });
    expect(res.status).toBe(400);
    // The parser's own sentence, which is the whole point of refusing here: it
    // says WHICH directive and why, to somebody holding a file they did not write.
    expect(asString(asRecord(await res.json()).message)).toMatch(/Endpoint/);
  });

  it("refuses a second tunnel under a name the org is using", async () => {
    const res = await api("/tunnels", owner, {
      method: "POST",
      body: JSON.stringify({ name: "Production VPC", config: conf() }),
    });
    expect(res.status).toBe(409);
    expect(asString(asRecord(await res.json()).message)).toMatch(/already have a tunnel/);
  });
});

describe("editing one", () => {
  it("renames it without the config being re-pasted", async () => {
    const res = await api(`/tunnels/${tunnelId}`, owner, {
      method: "PATCH",
      body: JSON.stringify({ name: "Production VPC (Frankfurt)" }),
    });
    expect(res.status).toBe(200);
    // The name moved and nothing else did — there was nothing to re-paste,
    // because the stored PrivateKey never comes back from the api.
    expect(asRecord(await res.json())).toMatchObject({
      name: "Production VPC (Frankfurt)",
      endpoint: SILENT_GATEWAY,
      allowedIps: ["10.0.0.0/8"],
    });
  });

  it("replaces the config whole, and the view follows it", async () => {
    const res = await api(`/tunnels/${tunnelId}`, owner, {
      method: "PATCH",
      body: JSON.stringify({
        config: conf({ endpoint: "127.0.0.1:51998", allowedIps: "10.0.0.0/8, 172.16.0.0/12" }),
      }),
    });
    expect(res.status).toBe(200);
    expect(asRecord(await res.json())).toMatchObject({
      name: "Production VPC (Frankfurt)",
      endpoint: "127.0.0.1:51998",
      allowedIps: ["10.0.0.0/8", "172.16.0.0/12"],
    });
  });

  it("refuses a patch that changes nothing", async () => {
    const res = await api(`/tunnels/${tunnelId}`, owner, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("keeps the stored config when a replacement does not parse", async () => {
    const res = await api(`/tunnels/${tunnelId}`, owner, {
      method: "PATCH",
      body: JSON.stringify({ config: "[Interface]\nAddress = 10.9.0.2/32\n" }),
    });
    expect(res.status).toBe(400);

    // The parse happens before the write, so the tunnel is still the one that
    // worked. A config saved and then found unusable would leave an owner with
    // a tunnel they cannot fix without the file they no longer have.
    const [stored] = await tunnels(owner);
    expect(stored).toMatchObject({ endpoint: "127.0.0.1:51998" });
  });
});

describe("testing one", () => {
  // The 8s probe window plus the netstack coming up.
  it("answers silence with a verdict rather than an error", async () => {
    const res = await api(`/tunnels/${tunnelId}/test`, owner, { method: "POST" });
    // 200, deliberately: "your gateway did not answer" is the ANSWER to this
    // request. An error status would make the dashboard draw a failed request.
    expect(res.status).toBe(200);
    const verdict = asRecord(await res.json());
    expect(verdict).toMatchObject({
      reachable: false,
      // Still trying in the background — the device's own window is far longer
      // than the one an owner watches.
      health: "HANDSHAKING",
      handshakeAgeSeconds: null,
      // No cause invented: an absent endpoint, a dropped port and a wrong
      // PublicKey are indistinguishable from this side.
      error: null,
    });
  }, 30_000);

  it("records the verdict on the trail, not just that somebody asked", async () => {
    const tested = await trail(owner, "TUNNEL_TESTED");
    expect(tested).toHaveLength(1);
    expect(tested[0]).toMatchObject({ target: "Production VPC (Frankfurt)" });
    expect(asRecord(tested[0]?.metadata)).toMatchObject({
      tunnelId,
      endpoint: "127.0.0.1:51998",
      // The gateway in this suite is a port nothing listens on, so the honest
      // row is a failed test — which is the row worth having.
      reachable: false,
      health: "HANDSHAKING",
      error: null,
    });
  });

  it("shows the tunnel as no longer idle once it has been asked", async () => {
    const [tunnel] = await tunnels(owner);
    expect(tunnel?.health).not.toBe("IDLE");
  });
});

describe("the refusals", () => {
  it("hides another organization's tunnel behind a 404", async () => {
    for (const [method, body] of [
      ["PATCH", JSON.stringify({ name: "theirs now" })],
      ["DELETE", undefined],
    ] as const) {
      const res = await api(`/tunnels/${tunnelId}`, outsider, {
        method,
        ...(body === undefined ? {} : { body }),
      });
      // Not 403: whether a tunnel exists in somebody else's org is a fact about
      // their account, and the same shape assertOwnsCluster uses.
      expect(res.status).toBe(404);
    }
    const test = await api(`/tunnels/${tunnelId}/test`, outsider, { method: "POST" });
    expect(test.status).toBe(404);
    expect(await tunnels(outsider)).toEqual([]);
  });

  it("lets a member read the list and refuses every write", async () => {
    // Knowing a VPN exists is not sensitive, and the secret half never leaves
    // the api — so the list is a member's to read.
    expect((await tunnels(member)).map((tunnel) => tunnel.id)).toContain(tunnelId);

    const create = await api("/tunnels", member, {
      method: "POST",
      body: JSON.stringify({ name: "Member's tunnel", config: conf() }),
    });
    expect(create.status).toBe(403);

    const patch = await api(`/tunnels/${tunnelId}`, member, {
      method: "PATCH",
      body: JSON.stringify({ name: "renamed by a member" }),
    });
    expect(patch.status).toBe(403);

    // A test sends datagrams to a customer's gateway on demand, which is a
    // write in every sense that matters here.
    const test = await api(`/tunnels/${tunnelId}/test`, member, { method: "POST" });
    expect(test.status).toBe(403);

    const remove = await api(`/tunnels/${tunnelId}`, member, { method: "DELETE" });
    expect(remove.status).toBe(403);
  });

  it("refuses an unauthenticated caller outright", async () => {
    expect((await api("/tunnels", null)).status).toBe(401);
    expect((await api(`/tunnels/${tunnelId}/test`, null, { method: "POST" })).status).toBe(401);
  });
});

// The tunnel was wired into the three ONBOARDING routes — they take a tunnel id
// from the connect form — and into the job pipeline. Everything a cluster's
// settings page does afterwards dialled around it: the credential re-check
// reported the customer's database as unreachable, and a rotated string was
// verified against a database the api cannot reach without the VPN.
//
// Asserted through the GUARD, which is what makes it decisive. A silent gateway
// is not enough: the tunnel still opens (the binary starts and listens), so a
// dial through it fails at the database and looks exactly like a direct dial that
// failed. So the fixture's host is 192.168.5.5 — OUTSIDE this tunnel's AllowedIPs
// and therefore refused by the tunnel guard, while the direct guard admits it,
// because this suite runs with ALLOW_PRIVATE_CLUSTER_TARGETS. One address, two
// verdicts, and only the tunnelled one is correct for a tunnelled cluster.
describe("a cluster reached through this tunnel", () => {
  let clusterId: string;

  beforeAll(async () => {
    const orgId = asString(asRecord(await (await api("/org", owner)).json()).id);
    // Real sealed credentials rather than dummy bytes: both routes unseal BEFORE
    // they reach the tunnel, so a fixture that cannot be opened would fail
    // earlier and prove nothing about this.
    const sealed = await seal(
      new TextEncoder().encode("mongodb://reader:secret@192.168.5.5:27017/app"),
      envKeyProvider(masterKeyBytesFor(1)),
    );
    const [row] = await db
      .insert(clusters)
      .values({
        orgId,
        name: "behind-the-vpn",
        engine: "MONGODB",
        sealedDek: Buffer.from(sealed.dek),
        sealedData: Buffer.from(sealed.data),
        keyVersion: 1,
        tunnelId,
      })
      .returning();
    if (row === undefined) throw new Error("could not create the fixture cluster");
    clusterId = row.id;
  });

  afterAll(async () => {
    // Before the removal test below: the FK is RESTRICT, and a tunnel still
    // reaching a cluster is refused — which is its own test, further up.
    await db
      .delete(clusters)
      .where(eq(clusters.id, clusterId))
      .catch(() => {});
  });

  it("re-checks the stored credentials THROUGH the tunnel", async () => {
    const res = await api(`/clusters/${clusterId}/privileges`, owner);

    // Refused, because the peer never agreed to carry this address. Dialling
    // around the tunnel gave a 200 whose body blamed the database — "server
    // unreachable — check the host, port and network access" — about an address
    // the tunnel would not have carried in the first place.
    expect(res.status).toBe(400);
    expect(asString(asRecord(await res.json()).message)).toMatch(/AllowedIPs/);
  });

  it("verifies a rotated string THROUGH the tunnel", async () => {
    const res = await api(`/clusters/${clusterId}/connection`, owner, {
      method: "PATCH",
      body: JSON.stringify({
        connectionString: "mongodb://reader:rotated@192.168.5.5:27017/app",
      }),
    });

    // Owner-only AND fresh-owner, so a 403 would mean the re-auth gate spoke
    // first — a different refusal, and one that would make this test vacuous.
    expect(res.status).toBe(400);
    expect(asString(asRecord(await res.json()).message)).toMatch(/AllowedIPs/);
  });
});

describe("the trail", () => {
  it("records the register and the two edits, with what each one did", async () => {
    const registered = await trail(owner, "TUNNEL_REGISTERED");
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      target: "Production VPC",
      actorEmail: owner.email,
    });
    expect(asRecord(registered[0]?.metadata)).toMatchObject({
      tunnelId,
      endpoint: SILENT_GATEWAY,
      allowedIps: ["10.0.0.0/8"],
      dns: ["10.9.0.1"],
    });

    // Newest first, so the config replacement is the first row and the rename
    // the second.
    const updated = await trail(owner, "TUNNEL_UPDATED");
    expect(updated).toHaveLength(2);

    const replaced = asRecord(updated[0]?.metadata);
    expect(replaced.name).toBeNull();
    // Both sides of it, because what a tunnel reached BEFORE is the question an
    // incident asks, and the config that would answer it has been overwritten.
    expect(asRecord(replaced.config)).toMatchObject({
      from: { endpoint: SILENT_GATEWAY, allowedIps: ["10.0.0.0/8"] },
      to: { endpoint: "127.0.0.1:51998", allowedIps: ["10.0.0.0/8", "172.16.0.0/12"] },
    });

    const renamed = asRecord(updated[1]?.metadata);
    expect(renamed.config).toBeNull();
    expect(asRecord(renamed.name)).toMatchObject({
      from: "Production VPC",
      to: "Production VPC (Frankfurt)",
    });
  });

  it("records nothing for the refusals", async () => {
    // The member's four attempts and the outsider's three left no rows: an act
    // that did not happen must not read as one that did.
    expect(await trail(owner, "TUNNEL_REGISTERED")).toHaveLength(1);
    expect(await trail(owner, "TUNNEL_UPDATED")).toHaveLength(2);
  });

  it("is the owner's to read and not the member's", async () => {
    expect((await api("/security-events?event=TUNNEL_UPDATED", member)).status).toBe(403);
  });
});

describe("removing one", () => {
  it("removes it, empties the list, and records the gateway it reached", async () => {
    const res = await api(`/tunnels/${tunnelId}`, owner, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(asRecord(await res.json())).toEqual({ deleted: true });
    expect(await tunnels(owner)).toEqual([]);

    const removed = await trail(owner, "TUNNEL_REMOVED");
    expect(removed).toHaveLength(1);
    // The row a column would have pointed at is gone, so the address it reached
    // is in the metadata — otherwise "a tunnel was removed" answers nothing.
    expect(asRecord(removed[0]?.metadata)).toMatchObject({
      tunnelId,
      endpoint: "127.0.0.1:51998",
      allowedIps: ["10.0.0.0/8", "172.16.0.0/12"],
    });
  });
});

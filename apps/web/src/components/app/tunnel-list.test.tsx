import type { TunnelView } from "@repo/contracts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tunnels } from "~/lib/queries/tunnels";
import { renderInApp } from "~/test-utils";
import { TunnelList } from "./tunnel-list";

const createTunnel = vi.hoisted(() => vi.fn());
const updateTunnel = vi.hoisted(() => vi.fn());
const deleteTunnel = vi.hoisted(() => vi.fn());
const testTunnel = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// The real client with these calls replaced, through a forwarding Proxy: the
// oRPC client is itself a Proxy over fetch, so spreading it yields `{}` and a
// call this test never set up would answer `undefined` instead of failing.
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return {
    ...actual,
    api: () => overriding(actual.api(), { createTunnel, updateTunnel, deleteTunnel, testTunnel }),
  };
});
// The real sonner with two of `toast`'s methods replaced, rather than an object
// named `toast`. A factory returning `{ toast: { success, error } }` swaps the
// WHOLE module — `Toaster` and every other export become undefined — and the two
// functions were checked against nothing. Built on a copy so sonner's own object
// is not mutated for whatever else imports it.
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(actual.toast), actual.toast, {
      success: toastSuccess,
      error: toastError,
    }),
  };
});

const CONFIG = [
  "[Interface]",
  "PrivateKey = 6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8=",
  "Address = 10.9.0.2/32",
  "",
  "[Peer]",
  "PublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=",
  "AllowedIPs = 10.0.0.0/8",
  "Endpoint = vpn.example.com:51820",
].join("\n");

const TUNNEL: TunnelView = {
  id: "t1",
  name: "Production VPC",
  endpoint: "vpn.example.com:51820",
  allowedIps: ["10.0.0.0/8"],
  dns: ["10.9.0.1"],
  health: "IDLE",
  handshakeAgeSeconds: null,
  clusterCount: 0,
  createdAt: "2026-08-27T09:00:00.000Z",
};

function read(tunnels: TunnelView[] = [TUNNEL], enabled = true): Tunnels {
  return { data: tunnels, enabled, pending: false, failed: false, retry: () => {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  createTunnel.mockResolvedValue(TUNNEL);
  updateTunnel.mockResolvedValue(TUNNEL);
  testTunnel.mockResolvedValue({
    reachable: false,
    health: "HANDSHAKING",
    handshakeAgeSeconds: null,
    error: null,
  });
});

describe("registering a tunnel", () => {
  // The api's rules, reached through the form: an empty submit says what is
  // missing under each field rather than doing nothing.
  it("refuses an empty registration with the reason under each field", async () => {
    const user = userEvent.setup();
    renderInApp(<TunnelList tunnels={read([])} canEdit />);

    await user.click(screen.getByRole("button", { name: "Register tunnel" }));

    expect(await screen.findByText("Name this tunnel")).toBeInTheDocument();
    expect(screen.getByText("Paste the wg0.conf your VPN gave you")).toBeInTheDocument();
    expect(createTunnel).not.toHaveBeenCalled();
  });

  it("sends the pasted config, trimming only the name", async () => {
    const user = userEvent.setup();
    renderInApp(<TunnelList tunnels={read([])} canEdit />);

    await user.type(screen.getByLabelText("Name"), "  Production VPC  ");
    await user.click(screen.getByLabelText("WireGuard config"));
    await user.paste(CONFIG);
    await user.click(screen.getByRole("button", { name: "Register tunnel" }));

    // The config goes as pasted — leading whitespace in a wg0.conf is the
    // author's, and the parser is the thing entitled to an opinion about it.
    expect(createTunnel).toHaveBeenCalledWith({ name: "Production VPC", config: CONFIG });
  });
});

describe("editing a tunnel", () => {
  async function openEditor(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    renderInApp(<TunnelList tunnels={read()} canEdit />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    return user;
  }

  it("prefills the name and cannot be saved until something changes", async () => {
    await openEditor();

    expect(screen.getByLabelText("Name")).toHaveValue("Production VPC");
    // Nothing to save is not the same as invalid: the api refuses a patch with
    // neither field, so the button says so before the click.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("renames without sending a config", async () => {
    const user = await openEditor();

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Frankfurt VPC");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // No `config` key at all, rather than an empty one: there is nothing to
    // prefill it with, so empty means "keep what is stored".
    expect(updateTunnel).toHaveBeenCalledWith({ tunnelId: "t1", name: "Frankfurt VPC" });
  });

  it("warns before replacing the config, and sends only the config", async () => {
    const user = await openEditor();

    await user.click(screen.getByLabelText("Replace the WireGuard config"));
    await user.paste(CONFIG);

    expect(
      await screen.findByText(/Saving this drops the live peering/, { exact: false }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateTunnel).toHaveBeenCalledWith({ tunnelId: "t1", config: CONFIG });
  });

  it("treats whitespace in the config box as an empty box", async () => {
    const user = await openEditor();

    await user.click(screen.getByLabelText("Replace the WireGuard config"));
    await user.paste("   \n  ");
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Frankfurt VPC");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // No error under the field either — whitespace is how somebody clears a box
    // they opened by accident.
    expect(updateTunnel).toHaveBeenCalledWith({ tunnelId: "t1", name: "Frankfurt VPC" });
  });
});

describe("testing a tunnel", () => {
  it("keeps the verdict on the row when the gateway stays silent", async () => {
    const user = userEvent.setup();
    renderInApp(<TunnelList tunnels={read()} canEdit />);

    await user.click(screen.getByRole("button", { name: "Test" }));

    // No cause invented — the three indistinguishable ones are named instead.
    expect(await screen.findByText(/No answer from the gateway/)).toBeInTheDocument();
    expect(screen.getByText(/Still retrying in the background/)).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith("The gateway did not answer");
  });

  it("shows the device's own reason when there is one", async () => {
    testTunnel.mockResolvedValue({
      reachable: false,
      health: "DOWN",
      handshakeAgeSeconds: null,
      error: "vpn.example.com resolves to a private address",
    });
    const user = userEvent.setup();
    renderInApp(<TunnelList tunnels={read()} canEdit />);

    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(
      await screen.findByText("vpn.example.com resolves to a private address"),
    ).toBeInTheDocument();
  });

  it("says so plainly when it answered", async () => {
    testTunnel.mockResolvedValue({
      reachable: true,
      health: "UP",
      handshakeAgeSeconds: 0.2,
      error: null,
    });
    const user = userEvent.setup();
    renderInApp(<TunnelList tunnels={read()} canEdit />);

    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText(/The gateway answered/)).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("The gateway answered");
  });

  it("offers nothing to a member", () => {
    renderInApp(<TunnelList tunnels={read()} canEdit={false} />);

    // Reads are a member's; every write, including a test that sends datagrams
    // to somebody's gateway, is the owner's.
    for (const name of ["Test", "Edit", "Remove", "Register tunnel"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

describe("a deployment with no tunnel service", () => {
  // The feature being off is a supported configuration, so the page has to say so
  // — the failure it replaces was a form that accepted a peering nothing could
  // ever bring up.
  it("says the feature is off and offers no registration form", () => {
    renderInApp(<TunnelList tunnels={read([], false)} canEdit />);

    expect(screen.getByText("VPN tunnels are turned off on this deployment")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register tunnel" })).not.toBeInTheDocument();
  });

  it("still lists what is registered, so an owner can see and remove it", () => {
    renderInApp(<TunnelList tunnels={read([TUNNEL], false)} canEdit />);

    expect(screen.getByText(TUNNEL.name)).toBeInTheDocument();
    expect(screen.getByText("VPN tunnels are turned off on this deployment")).toBeInTheDocument();
  });

  it("says nothing about it while the answer is still in flight", () => {
    // `enabled` defaults to true for exactly this: a page that flashed "the
    // feature is off" before its data arrived would be telling the reader
    // something untrue about their own deployment.
    renderInApp(
      <TunnelList
        tunnels={{ data: [], enabled: true, pending: true, failed: false, retry: () => {} }}
        canEdit
      />,
    );

    expect(
      screen.queryByText("VPN tunnels are turned off on this deployment"),
    ).not.toBeInTheDocument();
  });

  it("keeps the form when the feature is on", () => {
    renderInApp(<TunnelList tunnels={read([])} canEdit />);

    expect(screen.getByRole("button", { name: "Register tunnel" })).toBeInTheDocument();
    expect(
      screen.queryByText("VPN tunnels are turned off on this deployment"),
    ).not.toBeInTheDocument();
  });
});

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ClusterBar } from "./cluster-bar";

const setClusterMode = vi.hoisted(() => vi.fn());
const rotateConnection = vi.hoisted(() => vi.fn());
const disconnectCluster = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("~/lib/app-server", () => ({ setClusterMode, rotateConnection, disconnectCluster }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const NOW = new Date("2026-08-02T12:00:00Z");

const cluster = {
  id: "c1",
  name: "Production",
  readOnly: true,
  provisionedUsername: null,
  lastCollectedAt: NOW.toISOString(),
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  navigate.mockResolvedValue(undefined);
  setClusterMode.mockResolvedValue({ ok: true });
  rotateConnection.mockResolvedValue({ ok: true });
  disconnectCluster.mockResolvedValue({ ok: true, unhidden: 0, revokeCommand: null });
});

afterEach(() => {
  vi.useRealTimers();
});

// Open a ConfirmButton dialog and press its confirm action.
async function confirm(
  user: ReturnType<typeof userEvent.setup>,
  trigger: string,
  action: string,
): Promise<void> {
  await user.click(screen.getByRole("button", { name: trigger }));
  await user.click(await screen.findByRole("button", { name: action }));
}

describe("ClusterBar", () => {
  it("shows read-only and live as visually different states", () => {
    const { rerender } = renderInApp(
      <ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />,
    );
    expect(screen.getByText("read-only")).toBeInTheDocument();

    rerender(
      <ClusterBar
        cluster={{ ...cluster, readOnly: false }}
        clusters={[cluster]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  // Going live is the moment the engine gains permission to write, so it must
  // not be one stray click away.
  it("asks before enabling live mode", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Go live" }));
    expect(setClusterMode).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Go live" }));
    expect(setClusterMode).toHaveBeenCalledWith({ data: { clusterId: "c1", readOnly: false } });
  });

  // Going back to read-only only ever removes permission, so it needs no gate.
  it("goes read-only without a confirmation", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ClusterBar
        cluster={{ ...cluster, readOnly: false }}
        clusters={[cluster]}
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Make read-only" }));
    expect(setClusterMode).toHaveBeenCalledWith({ data: { clusterId: "c1", readOnly: true } });
  });

  it("asks before disconnecting, and says what happens to hidden indexes", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText(/Indexes still hidden in an observe window are restored/),
    ).toBeInTheDocument();
    expect(disconnectCluster).not.toHaveBeenCalled();
  });

  it("tells the reader how to revoke the scoped user it leaves behind", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ClusterBar
        cluster={{ ...cluster, provisionedUsername: "idx_abc" }}
        clusters={[cluster]}
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/dropUser\("idx_abc"\)/)).toBeInTheDocument();
  });

  it("reports restored indexes after a disconnect", async () => {
    disconnectCluster.mockResolvedValue({ ok: true, unhidden: 2, revokeCommand: null });
    const user = userEvent.setup();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />);

    await confirm(user, "Disconnect", "Disconnect");

    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("2 hidden indexes restored"));
    expect(navigate).toHaveBeenCalledWith({ to: "/app", search: {} });
  });

  // onChanged refetches the shell. A refused change moved nothing, so asking
  // for it again is a round trip that redraws the same badge.
  it("does not refetch when a mode change is refused", async () => {
    setClusterMode.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={onChanged} />);

    await confirm(user, "Go live", "Go live");

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("owner only"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  // Deselecting a cluster that is still connected would report a disconnect
  // that did not happen.
  it("keeps the cluster selected when the disconnect is refused", async () => {
    disconnectCluster.mockResolvedValue({ ok: false, unhidden: 0, revokeCommand: null });
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={onChanged} />);

    await confirm(user, "Disconnect", "Disconnect");

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("owner only"));
    expect(navigate).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("will not rotate to an empty string", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rotate string" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "mongodb://new:27017");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("passes the api's own reason through when a rotation is rejected", async () => {
    rotateConnection.mockResolvedValue({ ok: false, message: "cluster unreachable" });
    const user = userEvent.setup();
    renderInApp(<ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rotate string" }));
    await user.type(screen.getByRole("textbox"), "mongodb://dead:27017");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(toastError).toHaveBeenCalledWith("cluster unreachable");
  });

  // Stale figures reading as current is the failure this badge exists to stop.
  it("warns once collection has been silent for two days", async () => {
    const twoDays = new Date(NOW.getTime() - 50 * 3_600_000).toISOString();
    renderInApp(
      <ClusterBar
        cluster={{ ...cluster, lastCollectedAt: twoDays }}
        clusters={[cluster]}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(/last collected 2 days ago/)).toBeInTheDocument();
  });

  it("says nothing while collection is keeping up", () => {
    const recent = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    renderInApp(
      <ClusterBar
        cluster={{ ...cluster, lastCollectedAt: recent }}
        clusters={[cluster]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText(/last collected/)).not.toBeInTheDocument();
  });

  it("distinguishes never collected from stale", async () => {
    renderInApp(
      <ClusterBar
        cluster={{ ...cluster, lastCollectedAt: null }}
        clusters={[cluster]}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(/never collected/)).toBeInTheDocument();
  });

  it("offers a switcher only when there is more than one cluster", () => {
    const { rerender } = renderInApp(
      <ClusterBar cluster={cluster} clusters={[cluster]} onChanged={vi.fn()} />,
    );
    expect(screen.queryByLabelText("Select cluster")).not.toBeInTheDocument();

    rerender(
      <ClusterBar
        cluster={cluster}
        clusters={[cluster, { ...cluster, id: "c2", name: "Staging" }]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Select cluster")).toBeInTheDocument();
  });
});

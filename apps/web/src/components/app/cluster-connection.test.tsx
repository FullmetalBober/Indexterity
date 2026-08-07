import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { ClusterConnection } from "./cluster-connection";

const setClusterMode = vi.hoisted(() => vi.fn());
const rotateConnection = vi.hoisted(() => vi.fn());
const deleteCluster = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// The api client, called straight from the mutation hooks. A refusal is a throw
// with a status on it, not an { ok: false } a server function handed back.
vi.mock("~/lib/api", () => ({
  api: () => ({ setClusterMode, rotateConnection, deleteCluster }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const cluster = {
  id: "c1",
  name: "Production",
  readOnly: true,
  provisionedUsername: null,
};

beforeEach(() => {
  navigate.mockResolvedValue(undefined);
  setClusterMode.mockResolvedValue(cluster);
  rotateConnection.mockResolvedValue(cluster);
  deleteCluster.mockResolvedValue({ unhidden: 0, revokeCommand: null });
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

describe("ClusterConnection", () => {
  // Going live is the moment the engine gains permission to write, so it must
  // not be one stray click away.
  it("asks before enabling live mode", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await user.click(screen.getByRole("button", { name: "Go live" }));
    expect(setClusterMode).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Go live" }));
    expect(setClusterMode).toHaveBeenCalledWith({ clusterId: "c1", readOnly: false });
  });

  // Going back to read-only only ever removes permission, so it needs no gate.
  it("goes read-only without a confirmation", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={{ ...cluster, readOnly: false }} />);

    await user.click(screen.getByRole("button", { name: "Make read-only" }));
    expect(setClusterMode).toHaveBeenCalledWith({ clusterId: "c1", readOnly: true });
  });

  // The mode was a badge and a button in a bar above the numbers. On a page of
  // its own it can say what the mode MEANS, which is the part a reader deciding
  // whether to go live actually needs.
  it("says what each mode allows, not only which one is on", () => {
    const { rerender } = renderInApp(<ClusterConnection cluster={cluster} />);
    expect(screen.getByText(/nothing is applied/)).toBeInTheDocument();

    rerender(<ClusterConnection cluster={{ ...cluster, readOnly: false }} />);
    expect(screen.getByText(/may hide, drop and build/)).toBeInTheDocument();
  });

  it("asks before disconnecting, and says what happens to hidden indexes", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText(/Indexes still hidden in an observe window are restored/),
    ).toBeInTheDocument();
    expect(deleteCluster).not.toHaveBeenCalled();
  });

  it("tells the reader how to revoke the scoped user it leaves behind", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={{ ...cluster, provisionedUsername: "idx_abc" }} />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/dropUser\("idx_abc"\)/)).toBeInTheDocument();
  });

  it("reports restored indexes after a disconnect", async () => {
    deleteCluster.mockResolvedValue({ unhidden: 2, revokeCommand: null });
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await confirm(user, "Disconnect", "Disconnect");

    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("2 hidden indexes restored"));
    // Off this cluster's own pages, which is where the click happened. /app
    // decides what is left to show — another cluster, or the connect page.
    expect(navigate).toHaveBeenCalledWith({ to: "/app" });
  });

  // A refused change moved nothing, so asking for it again is a round trip
  // that redraws the same badge.
  it("does not refetch when a mode change is refused", async () => {
    setClusterMode.mockRejectedValue(apiError(403, "owner only"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<ClusterConnection cluster={cluster} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await confirm(user, "Go live", "Go live");

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("owner only"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refetches the cluster list once the mode really changed, and nothing else", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<ClusterConnection cluster={cluster} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await confirm(user, "Go live", "Go live");

    // The badge is drawn from the cluster list, so that is the one key this
    // moves. It used to move `shell`, which held the org and the member list in
    // the same entry — so going live refetched the team page too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["clusters"] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  // Disconnecting changes how many clusters the plan has used, and that counter
  // is part of the ORG payload, not the cluster list — the api resolves plan
  // usage server-side so a limit can be shown before someone hits it. The old
  // `shell` key held both in one entry and covered this by accident; with the
  // keys split it has to be said out loud, and the e2e suite caught it as a
  // stale "0 / 1 clusters" on the team page.
  it("refetches the org too, because the plan's cluster count lives there", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<ClusterConnection cluster={cluster} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await confirm(user, "Disconnect", "Disconnect");

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["clusters"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["org"] });
  });

  // Leaving the page of a cluster that is still connected would report a
  // disconnect that did not happen.
  it("stays on the cluster when the disconnect is refused", async () => {
    deleteCluster.mockRejectedValue(apiError(403, "owner only"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<ClusterConnection cluster={cluster} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await confirm(user, "Disconnect", "Disconnect");

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("owner only"));
    expect(navigate).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("will not rotate to an empty string", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await user.click(screen.getByRole("button", { name: "Rotate string" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(screen.getByLabelText("New connection string"), "mongodb://new:27017");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("passes the api's own reason through when a rotation is rejected", async () => {
    rotateConnection.mockRejectedValue(apiError(502, "cluster unreachable"));
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await user.click(screen.getByRole("button", { name: "Rotate string" }));
    await user.type(screen.getByLabelText("New connection string"), "mongodb://dead:27017");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(toastError).toHaveBeenCalledWith("cluster unreachable");
  });
});

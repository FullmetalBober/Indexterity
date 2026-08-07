import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { ClusterName } from "./cluster-name";

const renameCluster = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({ api: () => ({ renameCluster }) }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const cluster = { id: "c1", name: "Production" };

beforeEach(() => {
  vi.clearAllMocks();
  renameCluster.mockResolvedValue({ ...cluster, name: "Primary" });
});

describe("ClusterName", () => {
  it("shows the current name and sends a new one", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterName cluster={cluster} />);

    const field = screen.getByLabelText("Cluster name");
    expect(field).toHaveValue("Production");

    await user.clear(field);
    await user.type(field, "Primary");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(renameCluster).toHaveBeenCalledWith({ clusterId: "c1", name: "Primary" });
    expect(toastSuccess).toHaveBeenCalledWith('Renamed to "Primary"');
  });

  // Nothing to save is not the same as invalid: no error, no request, and a
  // button that cannot fire a toast claiming a change that did not happen.
  it("cannot be submitted while the name is unchanged", () => {
    renderInApp(<ClusterName cluster={cluster} />);

    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
  });

  // The shared validator's message, not a second copy of the rule — the same
  // object the connect form's Name field uses.
  it("refuses an empty name with the reason under the field", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterName cluster={cluster} />);

    await user.clear(screen.getByLabelText("Cluster name"));
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(await screen.findByText("Give the cluster a name")).toBeInTheDocument();
    expect(renameCluster).not.toHaveBeenCalled();
  });

  // Surrounding space is not a different name, so the field trims before it
  // compares and before it sends — otherwise "Production " is a rename to a name
  // that reads identically everywhere it is drawn.
  it("trims what it sends", async () => {
    const user = userEvent.setup();
    renderInApp(<ClusterName cluster={cluster} />);

    const field = screen.getByLabelText("Cluster name");
    await user.clear(field);
    await user.type(field, "  Primary  ");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(renameCluster).toHaveBeenCalledWith({ clusterId: "c1", name: "Primary" });
  });

  // "Rename failed" tells the reader nothing they can act on; the api's own
  // message names the cluster that already has the name.
  it("reads the api's refusal rather than replacing it", async () => {
    renameCluster.mockRejectedValue(
      apiError(400, 'this organization already has a cluster called "Primary" — pick another name'),
    );
    const user = userEvent.setup();
    renderInApp(<ClusterName cluster={cluster} />);

    const field = screen.getByLabelText("Cluster name");
    await user.clear(field);
    await user.type(field, "Primary");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(toastError).toHaveBeenCalledWith(
      'this organization already has a cluster called "Primary" — pick another name',
    );
  });
});

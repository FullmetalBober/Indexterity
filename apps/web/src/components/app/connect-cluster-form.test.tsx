import type { ConnectionDiagnosis, PrivilegeCheck } from "@repo/contracts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ConnectClusterForm } from "./connect-cluster-form";

const checkConnection = vi.hoisted(() => vi.fn());
const createCluster = vi.hoisted(() => vi.fn());
const provisionCluster = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

// The api client, called straight from the mutation hooks — the preflight and
// both connect paths now answer with the contract's own shapes rather than an
// { ok, message } envelope a server function built.
vi.mock("~/lib/api", () => ({
  api: () => ({ checkConnection, createCluster, provisionCluster }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

function privilege(key: string, granted: boolean): PrivilegeCheck {
  return { key, label: key, enables: `${key} does things`, tier: "CORE", granted };
}

function diagnosis(over: Partial<ConnectionDiagnosis> = {}): ConnectionDiagnosis {
  return {
    reachable: true,
    message: null,
    username: "appuser",
    authEnabled: true,
    canProvision: false,
    ready: true,
    canApply: true,
    privileges: [privilege("listIndexes", true)],
    missing: [],
    ...over,
  };
}

// Fill both fields and press Check access.
async function check(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Name"), "Production");
  await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");
  await user.click(screen.getByRole("button", { name: "Check access" }));
}

beforeEach(() => {
  navigate.mockResolvedValue(undefined);
});

describe("ConnectClusterForm", () => {
  // Both fields are required, and the form says which one is missing rather than
  // greying the button out and leaving the reader to work it out. Nothing is
  // asked of the api until they are both there.
  it("names the empty fields rather than checking with them", async () => {
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await user.click(screen.getByRole("button", { name: "Check access" }));

    expect(await screen.findByText("Give the cluster a name")).toBeInTheDocument();
    expect(screen.getByText("Paste a connection string")).toBeInTheDocument();
    expect(checkConnection).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Name"), "Production");
    await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");
    expect(screen.getByRole("button", { name: "Check access" })).toBeEnabled();
  });

  it("checks before it connects, and never stores anything on the check", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);

    expect(checkConnection).toHaveBeenCalledWith({ connectionString: "mongodb://host:27017" });
    expect(createCluster).not.toHaveBeenCalled();
    expect(provisionCluster).not.toHaveBeenCalled();
    expect(screen.getByText("appuser")).toBeInTheDocument();
  });

  it("connects with the pasted credentials when they are already enough", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "mongodb://host:27017",
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/app", search: { cluster: "c9" } });
  });

  // Provisioning is the recommended path when it is available, and using the
  // admin credentials as-is must stay an explicit second choice.
  it("offers to provision a scoped user when the credentials can create one", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);

    expect(
      screen.getByRole("button", { name: "Create a scoped user and connect" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use these credentials as-is" })).toBeInTheDocument();
    expect(screen.getByText(/no read access to your documents/)).toBeInTheDocument();
  });

  // The scoped user's string is the only copy the reader ever sees.
  it("shows the provisioned string once, with how to revoke it", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canProvision: true }));
    provisionCluster.mockResolvedValue({
      cluster: { id: "c9", name: "Production" },
      username: "idx_abc",
      connectionString: "mongodb://idx_abc:secret@host:27017",
    });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);
    await user.click(screen.getByRole("button", { name: "Create a scoped user and connect" }));

    expect(screen.getByText("mongodb://idx_abc:secret@host:27017")).toBeInTheDocument();
    expect(screen.getByText(/dropUser\("idx_abc"\)/)).toBeInTheDocument();
  });

  it("refuses to connect at all when core privileges are missing", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({ ready: false, canApply: false, missing: ["Index usage stats"] }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.getByText(/Analysis is not possible without these/)).toBeInTheDocument();
  });

  // Missing APPLY privileges are survivable — analysis still works — so the
  // reader must still be able to connect.
  it("still allows connecting when only the write privileges are missing", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canApply: false, missing: ["Drop indexes"] }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);

    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByText(/no change can be applied/)).toBeInTheDocument();
  });

  it("reports an unreachable cluster instead of offering to connect", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({ reachable: false, message: "cluster unreachable — check the host" }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);

    expect(screen.getByText("cluster unreachable — check the host")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("surfaces a failed check rather than swallowing it", async () => {
    checkConnection.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);

    expect(screen.getByText("could not check the connection")).toBeInTheDocument();
  });

  // Editing the string invalidates the verdict — otherwise the reader could
  // connect a different string than the one that was checked.
  it("discards the diagnosis when the connection string is edited", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm />);

    await check(user);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Connection string"), "9");
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});

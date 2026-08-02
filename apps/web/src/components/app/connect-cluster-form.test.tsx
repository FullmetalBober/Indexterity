import type { ConnectionDiagnosis, PrivilegeCheck } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectClusterForm } from "./connect-cluster-form";

const checkConnection = vi.hoisted(() => vi.fn());
const connectCluster = vi.hoisted(() => vi.fn());
const provisionCluster = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());

vi.mock("~/lib/app-server", () => ({ checkConnection, connectCluster, provisionCluster }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouter: () => ({ invalidate }),
}));

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
  invalidate.mockResolvedValue(undefined);
});

describe("ConnectClusterForm", () => {
  // The whole point of the preflight: nothing is stored until the reader has
  // seen what the credentials can do.
  it("will not check until both fields are filled", async () => {
    const user = userEvent.setup();
    render(<ConnectClusterForm />);
    const button = screen.getByRole("button", { name: "Check access" });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "Production");
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");
    expect(button).toBeEnabled();
  });

  it("checks before it connects, and never stores anything on the check", async () => {
    checkConnection.mockResolvedValue({ ok: true, diagnosis: diagnosis() });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);

    expect(checkConnection).toHaveBeenCalledWith({ data: "mongodb://host:27017" });
    expect(connectCluster).not.toHaveBeenCalled();
    expect(provisionCluster).not.toHaveBeenCalled();
    expect(screen.getByText("appuser")).toBeInTheDocument();
  });

  it("connects with the pasted credentials when they are already enough", async () => {
    checkConnection.mockResolvedValue({ ok: true, diagnosis: diagnosis() });
    connectCluster.mockResolvedValue({ ok: true, message: null, id: "c9" });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(connectCluster).toHaveBeenCalledWith({
      data: { name: "Production", connectionString: "mongodb://host:27017" },
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/app", search: { cluster: "c9" } });
  });

  // Provisioning is the recommended path when it is available, and using the
  // admin credentials as-is must stay an explicit second choice.
  it("offers to provision a scoped user when the credentials can create one", async () => {
    checkConnection.mockResolvedValue({ ok: true, diagnosis: diagnosis({ canProvision: true }) });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);

    expect(
      screen.getByRole("button", { name: "Create a scoped user and connect" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use these credentials as-is" })).toBeInTheDocument();
    expect(screen.getByText(/no read access to your documents/)).toBeInTheDocument();
  });

  // The scoped user's string is the only copy the reader ever sees.
  it("shows the provisioned string once, with how to revoke it", async () => {
    checkConnection.mockResolvedValue({ ok: true, diagnosis: diagnosis({ canProvision: true }) });
    provisionCluster.mockResolvedValue({
      ok: true,
      message: null,
      id: "c9",
      username: "idx_abc",
      connectionString: "mongodb://idx_abc:secret@host:27017",
    });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);
    await user.click(screen.getByRole("button", { name: "Create a scoped user and connect" }));

    expect(screen.getByText("mongodb://idx_abc:secret@host:27017")).toBeInTheDocument();
    expect(screen.getByText(/dropUser\("idx_abc"\)/)).toBeInTheDocument();
  });

  it("refuses to connect at all when core privileges are missing", async () => {
    checkConnection.mockResolvedValue({
      ok: true,
      diagnosis: diagnosis({ ready: false, canApply: false, missing: ["Index usage stats"] }),
    });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.getByText(/Analysis is not possible without these/)).toBeInTheDocument();
  });

  // Missing APPLY privileges are survivable — analysis still works — so the
  // reader must still be able to connect.
  it("still allows connecting when only the write privileges are missing", async () => {
    checkConnection.mockResolvedValue({
      ok: true,
      diagnosis: diagnosis({ canApply: false, missing: ["Drop indexes"] }),
    });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);

    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByText(/no change can be applied/)).toBeInTheDocument();
  });

  it("reports an unreachable cluster instead of offering to connect", async () => {
    checkConnection.mockResolvedValue({
      ok: true,
      diagnosis: diagnosis({ reachable: false, message: "cluster unreachable — check the host" }),
    });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);

    expect(screen.getByText("cluster unreachable — check the host")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("surfaces a failed check rather than swallowing it", async () => {
    checkConnection.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);

    expect(screen.getByText("could not check the connection")).toBeInTheDocument();
  });

  // Editing the string invalidates the verdict — otherwise the reader could
  // connect a different string than the one that was checked.
  it("discards the diagnosis when the connection string is edited", async () => {
    checkConnection.mockResolvedValue({ ok: true, diagnosis: diagnosis() });
    const user = userEvent.setup();
    render(<ConnectClusterForm />);

    await check(user);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Connection string"), "9");
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});

import type { ConnectionDiagnosis, PlanInfo, PrivilegeCheck } from "@repo/contracts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ConnectClusterForm } from "./connect-cluster-form";

// Every check box cleared — what the form sends when nobody touches them, and
// what the api reads a missing field as.
const NONE = {
  allowInvalidCertificates: false,
  allowInvalidHostnames: false,
  insecure: false,
};

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

function privilege(
  key: string,
  granted: boolean,
  tier: PrivilegeCheck["tier"] = "CORE",
): PrivilegeCheck {
  return { key, label: key, enables: `${key} does things`, tier, granted };
}

// The three provisioning checks as the api reports them, all in one state.
function provisioning(granted: boolean): PrivilegeCheck[] {
  return ["createRole", "createUser", "grantRole"].map((key) =>
    privilege(key, granted, "PROVISION"),
  );
}

// Room for another cluster unless a test says otherwise — every render draws
// the quota, and only the three tests below are about what it says.
function plan(over: Partial<PlanInfo> = {}): PlanInfo {
  return {
    plan: "PRO",
    maxClusters: 5,
    maxMembers: 5,
    workloadAnalysis: true,
    autoApply: true,
    clustersUsed: 1,
    membersUsed: 1,
    ...over,
  };
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
  // The whole point of the quota being here rather than on the org page: it is
  // read before anything is typed, not after a 402.
  it("shows what the plan has left before a string is pasted", () => {
    renderInApp(<ConnectClusterForm plan={plan({ clustersUsed: 2 })} />);

    expect(screen.getByText(/2 \/ 5 clusters on the PRO plan/)).toBeInTheDocument();
    expect(screen.queryByText("No room for another cluster")).not.toBeInTheDocument();
  });

  // Full, and still not disabled: checking a string stores nothing, and the api
  // owns the refusal.
  it("warns when the plan is already full, without disabling the form", () => {
    renderInApp(<ConnectClusterForm plan={plan({ plan: "FREE", maxClusters: 1 })} />);

    expect(screen.getByText("No room for another cluster")).toBeInTheDocument();
    expect(screen.getByText(/The FREE plan allows 1 cluster\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check access" })).toBeEnabled();
  });

  // A null cap is unlimited, which can never be full and has no "/ n" to show.
  it("counts without a limit on a plan that has none", () => {
    renderInApp(
      <ConnectClusterForm
        plan={plan({ plan: "ENTERPRISE", maxClusters: null, clustersUsed: 9 })}
      />,
    );

    expect(screen.getByText(/9 clusters on the ENTERPRISE plan/)).toBeInTheDocument();
    expect(screen.queryByText("No room for another cluster")).not.toBeInTheDocument();
  });

  // Both fields are required, and the form says which one is missing rather than
  // greying the button out and leaving the reader to work it out. Nothing is
  // asked of the api until they are both there.
  it("names the empty fields rather than checking with them", async () => {
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

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
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(checkConnection).toHaveBeenCalledWith({
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
    });
    expect(createCluster).not.toHaveBeenCalled();
    expect(provisionCluster).not.toHaveBeenCalled();
    expect(screen.getByText("appuser")).toBeInTheDocument();
  });

  it("connects with the pasted credentials when they are already enough", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
    });
    // Onto the new cluster's own page. It used to be a search param on /app,
    // which meant a connected cluster had no address of its own (#81).
    expect(navigate).toHaveBeenCalledWith({
      to: "/app/clusters/$clusterId",
      params: { clusterId: "c9" },
    });
  });

  // Provisioning is the recommended path when it is available, and using the
  // admin credentials as-is must stay an explicit second choice.
  it("offers to provision a scoped user when the credentials can create one", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

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
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("button", { name: "Create a scoped user and connect" }));

    expect(screen.getByText("mongodb://idx_abc:secret@host:27017")).toBeInTheDocument();
    expect(screen.getByText(/dropUser\("idx_abc"\)/)).toBeInTheDocument();
  });

  // #86: this branch used to draw a Connect button and say nothing else, so
  // "these credentials cannot create users" was indistinguishable from "we could
  // not tell what they can do" — and the reader was never told the safer path
  // existed, let alone which grant would open it.
  it("names the missing action when no scoped user can be offered", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({
        privileges: [
          privilege("listIndexes", true),
          privilege("createRole", true, "PROVISION"),
          privilege("createUser", false, "PROVISION"),
          privilege("grantRole", false, "PROVISION"),
        ],
      }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    // Still connectable — the credentials work, they just cannot make a better
    // set of credentials.
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByText(/No scoped user was offered/)).toBeInTheDocument();
    // The exact actions, not "some privileges": the reader has to go and change a
    // role on their own cluster, and createUser alone is a different grant from
    // all three. Named in the sentence AND ticked off in the list above it, hence
    // getAllByText — two mentions of one action is the intent, not a duplicate.
    const note = screen.getByText(/No scoped user was offered/);
    expect(note.textContent).toContain("createUser");
    expect(note.textContent).toContain("grantRole");
    // And not the one they do have.
    expect(note.textContent).not.toContain("createRole");
    // And what connecting as-is costs, which is the part nobody was told.
    expect(screen.getByText(/stores the string you pasted/)).toBeInTheDocument();
  });

  // Every provisioning action is granted here and the offer is still withheld,
  // because a server that asks for no credentials cannot enforce a dedicated
  // user. Naming a grant would send the reader after a privilege they already
  // have; the diagnosis message is what explains this one.
  it("stays quiet about provisioning on a deployment with authentication off", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({
        authEnabled: false,
        username: null,
        message: "this deployment has authentication disabled",
        privileges: [privilege("listIndexes", true), ...provisioning(true)],
      }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByText(/No scoped user was offered/)).not.toBeInTheDocument();
  });

  // The list is the evidence for whichever answer the form gives above it, so the
  // provisioning actions belong in it either way (#86).
  it("lists the provisioning actions alongside the engine's own", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({ privileges: [privilege("listIndexes", true), ...provisioning(false)] }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByText(/To create a scoped user instead/)).toBeInTheDocument();
    for (const key of ["createRole", "createUser", "grantRole"]) {
      expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    }
  });

  it("refuses to connect at all when core privileges are missing", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({ ready: false, canApply: false, missing: ["Index usage stats"] }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.getByText(/Analysis is not possible without these/)).toBeInTheDocument();
  });

  // Missing APPLY privileges are survivable — analysis still works — so the
  // reader must still be able to connect.
  it("still allows connecting when only the write privileges are missing", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canApply: false, missing: ["Drop indexes"] }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.getByText(/no change can be applied/)).toBeInTheDocument();
  });

  it("reports an unreachable cluster instead of offering to connect", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({ reachable: false, message: "cluster unreachable — check the host" }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByText("cluster unreachable — check the host")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("surfaces a failed check rather than swallowing it", async () => {
    checkConnection.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByText("could not check the connection")).toBeInTheDocument();
  });

  // Editing the string invalidates the verdict — otherwise the reader could
  // connect a different string than the one that was checked.
  it("discards the diagnosis when the connection string is edited", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Connection string"), "9");
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});

// Each box gives up one check that TLS is otherwise there to perform, and the
// api refuses the matching connection-string option unless the box was ticked.
// So the box is the only way to connect a cluster whose certificate does not
// verify — and it has to reach the api, or it is decoration.
describe("ConnectClusterForm certificate checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the ticked box with the check", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Name"), "Production");
    await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");
    await user.click(screen.getByLabelText("Allow an unverified certificate"));
    await user.click(screen.getByRole("button", { name: "Check access" }));

    expect(checkConnection).toHaveBeenCalledWith({
      connectionString: "mongodb://host:27017",
      tlsOverrides: { ...NONE, allowInvalidCertificates: true },
    });
  });

  // Three separate concessions, not one. A private CA fails certificate
  // validation with a perfectly correct hostname; ticking that box must not also
  // give up the hostname check.
  it("keeps the three boxes independent", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Name"), "Production");
    await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");
    await user.click(screen.getByLabelText("Allow a mismatched hostname"));
    await user.click(screen.getByRole("button", { name: "Check access" }));

    expect(checkConnection).toHaveBeenCalledWith({
      connectionString: "mongodb://host:27017",
      tlsOverrides: { ...NONE, allowInvalidHostnames: true },
    });
  });

  // A diagnosis describes one exact connection, and the boxes are part of it —
  // so moving one has to clear the answer above, exactly as editing the string
  // does. Otherwise the reader connects on the strength of a check that was run
  // against different settings.
  it("drops a diagnosis when a box moves", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    expect(screen.getByText("appuser")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Skip every certificate check"));
    expect(screen.queryByText("appuser")).not.toBeInTheDocument();
  });

  it("carries the boxes into the connect, not only the check", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Name"), "Production");
    await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");
    await user.click(screen.getByLabelText("Allow an unverified certificate"));
    await user.click(screen.getByRole("button", { name: "Check access" }));
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "mongodb://host:27017",
      tlsOverrides: { ...NONE, allowInvalidCertificates: true },
    });
  });
});

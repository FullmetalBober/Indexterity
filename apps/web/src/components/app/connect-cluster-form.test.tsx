import type { ConnectionDiagnosis, PlanInfo, PrivilegeCheck } from "@repo/contracts";
import { clusterEngine, engineFromScheme } from "@repo/contracts";
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
const listSupportedEngines = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

// What the api says this build can connect (#239). Both engines by default,
// because the question the form has to answer before anything is typed is
// whether SQL Server is supported at all.
const ENGINES = [
  { engine: "MONGODB" as const, connStringHint: "mongodb:// or mongodb+srv://" },
  {
    engine: "MSSQL" as const,
    connStringHint: "mssql://user:password@host:1433 or Server=host;User Id=…;Password=…",
  },
];

// The api client, called straight from the mutation hooks — the preflight and
// both connect paths now answer with the contract's own shapes rather than an
// { ok, message } envelope a server function built.
vi.mock("~/lib/api", () => ({
  api: () => ({ checkConnection, createCluster, provisionCluster, listSupportedEngines }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

function privilege(
  key: string,
  granted: boolean,
  tier: PrivilegeCheck["tier"] = "CORE",
): PrivilegeCheck {
  return { key, label: key, enables: `${key} does things`, tier, granted, command: null };
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
    // The api's verdict about which engine answered, which is what the form shows
    // once a check has run rather than its own reading of the string.
    engine: "MONGODB",
    reachable: true,
    message: null,
    username: "appuser",
    authEnabled: true,
    canProvision: false,
    ready: true,
    canApply: true,
    privileges: [privilege("listIndexes", true)],
    // Nothing surplus by default (#313). The connect form does not draw this
    // list — it is the settings card's — so every test here wants it empty and
    // out of the way.
    surplus: [],
    missing: [],
    // One database by default, so the observe boxes stay out of the tests that are
    // not about them — a single-database cluster has nothing to choose between.
    databases: ["app"],
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
  listSupportedEngines.mockResolvedValue(ENGINES);
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

  // #244. One database is not a choice, and drawing boxes for it would imply the
  // single box could be unticked — which the api refuses.
  it("does not ask which databases to observe when there is only one", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app"] }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.queryByText(/Databases to observe/)).not.toBeInTheDocument();
  });

  it("offers every database, ticked, once the cluster reports more than one", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app", "staging"] }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByText(/Databases to observe/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "app" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "staging" })).toBeChecked();
  });

  it("connects with only the databases left ticked", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app", "staging"] }));
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
      observedDatabases: ["app"],
    });
  });

  // Ticking the last box back means "all of them" and not "this exact list": the
  // api stores null for that, and null is what keeps a database added next month
  // observed too. A complete list would silently stop at today's databases.
  it("sends nothing at all when every box ends up ticked again", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app", "staging"] }));
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
      observedDatabases: undefined,
    });
  });

  it("refuses to leave nothing observed, and says what to do instead", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app", "staging"] }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("checkbox", { name: "app" }));
    await user.click(screen.getByRole("checkbox", { name: "staging" }));

    expect(screen.getByText(/Pick at least one database/)).toBeInTheDocument();
  });

  // The verdict depends on the scope, so a narrowed selection beside a diagnosis
  // that was computed for the whole cluster is stale in a way the reader cannot
  // see. Offered only when there is a gap the narrowing could close.
  it("offers to re-check when the selection narrows and privileges are missing", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({
        databases: ["app", "staging"],
        ready: false,
        missing: ["indexStats"],
        privileges: [privilege("indexStats", false)],
      }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    expect(screen.queryByRole("button", { name: "Check these instead" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.click(screen.getByRole("button", { name: "Check these instead" }));

    expect(checkConnection).toHaveBeenLastCalledWith({
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
      observedDatabases: ["app"],
    });
  });

  // The screen the founder caught: Query Store off on one database, that database
  // unticked, and the row went on naming it with a command to enable it — because
  // the offer to re-ask was gated on `missing`, which carries CORE and APPLY only.
  // Query Store is WORKLOAD, so a Query-Store-only gap could never refresh itself.
  it("offers to re-check when only Query Store is missing and the selection narrows", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({
        databases: ["app", "distribution"],
        // Ready and appliable: the ONLY gap is the workload signal, so `missing` is
        // empty and the old condition drew nothing.
        ready: true,
        canApply: true,
        missing: [],
        privileges: [
          privilege("viewServerState", true),
          privilege("queryStore", false, "WORKLOAD"),
        ],
      }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    expect(screen.queryByRole("button", { name: "Check these instead" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "distribution" }));
    expect(screen.getByRole("button", { name: "Check these instead" })).toBeInTheDocument();
    // And it says which two sets it is comparing, so the line is readable without
    // counting checkboxes.
    expect(
      screen.getByText(/computed for every database, not the 1 now ticked/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check these instead" }));
    expect(checkConnection).toHaveBeenLastCalledWith({
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
      observedDatabases: ["app"],
    });
  });

  // Those three are evaluated on the server and on `admin`, so narrowing the
  // databases cannot move them. An offer that provably changes nothing is how a
  // line like this teaches people to ignore it.
  it("does not offer to re-check when the only gaps are provisioning ones", async () => {
    checkConnection.mockResolvedValue(
      diagnosis({
        databases: ["app", "distribution"],
        privileges: [privilege("viewServerState", true), ...provisioning(false)],
      }),
    );
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("checkbox", { name: "distribution" }));

    expect(screen.queryByRole("button", { name: "Check these instead" })).not.toBeInTheDocument();
  });

  it("does not offer to re-check when nothing is missing", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app", "staging"] }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("checkbox", { name: "staging" }));

    expect(screen.queryByRole("button", { name: "Check these instead" })).not.toBeInTheDocument();
  });

  // Editing the string is editing the cluster: the names were chosen from a list
  // the previous string produced.
  it("forgets the selection when the connection string changes", async () => {
    checkConnection.mockResolvedValue(diagnosis({ databases: ["app", "staging"] }));
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.type(screen.getByLabelText("Connection string"), "9");
    await user.click(screen.getByRole("button", { name: "Check access" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "mongodb://host:270179",
      tlsOverrides: NONE,
      observedDatabases: undefined,
    });
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
      cluster: { id: "c9", name: "Production", engine: "MONGODB" },
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

// Nothing on this screen used to say SQL Server was supported: the placeholder
// said `mongodb://` and the helper text said "any connection string", so an
// owner with a SQL Server read the form as a no while the adapter had been
// shipping since #36 (#239).
describe("ConnectClusterForm engines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigate.mockResolvedValue(undefined);
    listSupportedEngines.mockResolvedValue(ENGINES);
  });

  it("names every engine this build takes, with the api's own hints", async () => {
    renderInApp(<ConnectClusterForm plan={plan()} />);

    expect(await screen.findByText("SQL Server")).toBeInTheDocument();
    expect(screen.getByText("MongoDB")).toBeInTheDocument();
    // The adapter's own sentence, so the form and the refusal a bad string
    // produces cannot describe different products.
    expect(screen.getByText("mongodb:// or mongodb+srv://")).toBeInTheDocument();
    expect(
      screen.getByText("mssql://user:password@host:1433 or Server=host;User Id=…;Password=…"),
    ).toBeInTheDocument();
  });

  // The field itself has to stop implying MongoDB-only, because the placeholder is
  // what a reader looks at before they read anything else.
  //
  // Asserted through the product's OWN scheme sniffer against the contract's OWN
  // engine list, rather than against strings spelled here. This test used to say
  // "both dialects" and passed for a release after PostgreSQL shipped, because two
  // of three satisfied it. Now every example in the placeholder has to be
  // recognisable as the engine it stands for, and the next adapter added to
  // ClusterEngine fails this test until the field mentions it.
  it("names every supported engine, recognisably", () => {
    renderInApp(<ConnectClusterForm plan={plan()} />);

    const placeholder = screen.getByLabelText("Connection string").getAttribute("placeholder");
    const detected = new Set(
      (placeholder ?? "").split("·").map((example) => engineFromScheme(example.trim())),
    );

    expect(detected).toEqual(new Set(clusterEngine.options));
  });

  it("says which engine it is reading an ADO string as, before any check", async () => {
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(
      screen.getByLabelText("Connection string"),
      "Server=db;User Id=sa;Password=secret",
    );

    const note = await screen.findByText(/Reading this as/);
    expect(note.textContent).toContain("SQL Server");
    // A guess off the scheme until the api answers, and it says so rather than
    // asserting something it cannot know yet.
    expect(note.textContent).toContain("confirmed when you check access");
  });

  // The api's verdict replaces the browser's guess, and the wording that hangs
  // off it comes with it: `db.dropUser` is the wrong sentence in front of a SQL
  // Server, and this is the branch that used to show it anyway.
  it("takes the engine from the diagnosis once there is one", async () => {
    checkConnection.mockResolvedValue(diagnosis({ engine: "MSSQL", canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(await screen.findByText(/no permission to read a single row/)).toBeInTheDocument();
    expect(screen.getByText(/DROP LOGIN indexterity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a scoped login and connect/ })).toBeTruthy();
  });

  it("prints the engine's own revoke command with the provisioned login", async () => {
    checkConnection.mockResolvedValue(diagnosis({ engine: "MSSQL", canProvision: true }));
    provisionCluster.mockResolvedValue({
      cluster: { id: "c9", name: "Production", engine: "MSSQL" },
      username: "idx_abc",
      connectionString: "mssql://idx_abc:secret@host:1433",
    });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);
    await user.click(screen.getByRole("button", { name: /Create a scoped login and connect/ }));

    expect(await screen.findByText("mssql://idx_abc:secret@host:1433")).toBeInTheDocument();
    expect(screen.getByText(/DROP LOGIN idx_abc/)).toBeInTheDocument();
    expect(screen.queryByText(/dropUser/)).not.toBeInTheDocument();
  });

  // No override on a string an engine recognises. That is the whole reason this is
  // not a picker: choosing MongoDB and pasting `Server=…` would make the api
  // honour the choice and refuse a string it would otherwise have accepted.
  it("offers no engine choice while the string is recognised", async () => {
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Connection string"), "mongodb://host:27017");

    expect(screen.queryByLabelText("Which engine is this")).not.toBeInTheDocument();
  });

  it("asks which engine it is only when nothing recognises the string", async () => {
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Connection string"), "db.example.com:1433");

    expect(await screen.findByLabelText("Which engine is this")).toBeInTheDocument();
    expect(screen.getByText(/No engine recognises this string/)).toBeInTheDocument();
  });

  it("sends the chosen engine with the check and the connect", async () => {
    checkConnection.mockResolvedValue(diagnosis({ engine: "MSSQL" }));
    createCluster.mockResolvedValue({ id: "c9", name: "Production" });
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Name"), "Production");
    await user.type(screen.getByLabelText("Connection string"), "db.example.com:1433");
    await user.click(await screen.findByLabelText("Which engine is this"));
    await user.click(await screen.findByRole("option", { name: "SQL Server" }));
    await user.click(screen.getByRole("button", { name: "Check access" }));

    expect(checkConnection).toHaveBeenCalledWith({
      connectionString: "db.example.com:1433",
      tlsOverrides: NONE,
      engine: "MSSQL",
    });

    await user.click(await screen.findByRole("button", { name: "Connect" }));
    // Into the connect too, and not only the check: the api re-decides per
    // request, so an override that reached one and not the other would store a
    // different engine than the one that was diagnosed.
    expect(createCluster).toHaveBeenCalledWith({
      name: "Production",
      connectionString: "db.example.com:1433",
      tlsOverrides: NONE,
      engine: "MSSQL",
    });
  });

  // Picking an engine is part of what was asked, so it invalidates the answer on
  // screen exactly as editing the string or a certificate box does.
  it("drops the diagnosis when the engine choice changes", async () => {
    checkConnection.mockResolvedValue(diagnosis({ engine: "MSSQL" }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Name"), "Production");
    await user.type(screen.getByLabelText("Connection string"), "db.example.com:1433");
    await user.click(await screen.findByLabelText("Which engine is this"));
    await user.click(await screen.findByRole("option", { name: "SQL Server" }));
    await user.click(screen.getByRole("button", { name: "Check access" }));
    expect(await screen.findByText("appuser")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Which engine is this"));
    await user.click(await screen.findByRole("option", { name: "MongoDB" }));
    expect(screen.queryByText("appuser")).not.toBeInTheDocument();
  });

  // A pick made while nothing recognised the string must not outlive that state:
  // the reader fixes the string, and the engine it now names is the api's to
  // decide again.
  it("stops sending a stale choice once the string names its own engine", async () => {
    checkConnection.mockResolvedValue(diagnosis());
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await user.type(screen.getByLabelText("Name"), "Production");
    const field = screen.getByLabelText("Connection string");
    await user.type(field, "db.example.com:1433");
    await user.click(await screen.findByLabelText("Which engine is this"));
    await user.click(await screen.findByRole("option", { name: "SQL Server" }));

    await user.clear(field);
    await user.type(field, "mongodb://host:27017");
    await user.click(screen.getByRole("button", { name: "Check access" }));

    expect(checkConnection).toHaveBeenCalledWith({
      connectionString: "mongodb://host:27017",
      tlsOverrides: NONE,
      engine: undefined,
    });
  });

  // The list is read from the api, so a build with one adapter says so rather
  // than naming an engine it cannot connect.
  it("names only what the build carries", async () => {
    listSupportedEngines.mockResolvedValue([ENGINES[0]]);
    renderInApp(<ConnectClusterForm plan={plan()} />);

    expect(await screen.findByText("MongoDB")).toBeInTheDocument();
    expect(screen.queryByText("SQL Server")).not.toBeInTheDocument();
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

// PostgreSQL's adapter shipping turned the old `engine === "MSSQL" ? … : mongo`
// fallback into a lie: a Postgres cluster was offered the `indexterityEngine`
// role, told it withheld read access to its "documents", and pointed at
// `db.dropUser`. Every one of those is MongoDB's. The table is a full Record now,
// so the compiler refuses a missing engine — these assert the words themselves.
describe("ConnectClusterForm — PostgreSQL", () => {
  it("describes the role it would create in PostgreSQL's own terms", async () => {
    checkConnection.mockResolvedValue(diagnosis({ engine: "POSTGRESQL", canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(await screen.findByText(/pg_monitor/)).toBeInTheDocument();
    // Both halves: a bare DROP ROLE is refused while the grants above still
    // point at the role, so the sentence has to name DROP OWNED BY too.
    expect(screen.getByText(/DROP OWNED BY indexterity/)).toBeInTheDocument();
    expect(screen.getByText(/DROP ROLE indexterity/)).toBeInTheDocument();
    // None of MongoDB's sentence survives.
    expect(screen.queryByText(/indexterityEngine/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dropUser/)).not.toBeInTheDocument();
    expect(screen.queryByText(/your documents/)).not.toBeInTheDocument();
  });

  // The role withholds MORE here than on the other two engines, and that is the
  // half somebody reading "exactly the privileges above and nothing else" has to
  // understand.
  it("says the provisioned role cannot apply, and names the way it could", async () => {
    checkConnection.mockResolvedValue(diagnosis({ engine: "POSTGRESQL", canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(await screen.findByText(/It cannot change an index either/)).toBeInTheDocument();
    // The limitation is no longer permanent (#332), so the copy that states it
    // has to name the way out — otherwise a reader concludes PostgreSQL simply
    // cannot apply, which was true and is not any more.
    expect(await screen.findByText(/pg_cron/)).toBeInTheDocument();
  });

  // A property of the engine rather than of these credentials, so it shows on a
  // string that CAN apply too — somebody connecting read-only still needs to know
  // what going live would later cost.
  it("warns that applying needs the table owner, whichever way canApply reads", async () => {
    for (const canApply of [true, false]) {
      checkConnection.mockResolvedValue(diagnosis({ engine: "POSTGRESQL", canApply }));
      const user = userEvent.setup();
      const { unmount } = renderInApp(<ConnectClusterForm plan={plan()} />);
      await check(user);
      expect(
        await screen.findByText(/Applying on PostgreSQL needs the table owner/),
      ).toBeInTheDocument();
      expect(screen.getByText(/no grantable index privilege/)).toBeInTheDocument();
      unmount();
    }
  });

  // And it does not appear where it would be false.
  it("says none of that for the other two engines", async () => {
    for (const engine of ["MONGODB", "MSSQL"] as const) {
      checkConnection.mockResolvedValue(diagnosis({ engine }));
      const user = userEvent.setup();
      const { unmount } = renderInApp(<ConnectClusterForm plan={plan()} />);
      await check(user);
      expect(screen.queryByText(/Applying on PostgreSQL needs the table owner/)).toBeNull();
      unmount();
    }
  });
});

// #313. An org that has decided least privilege is mandatory: the button that
// stores an admin string as-is stops being offered at all.
describe("ConnectClusterForm with least privilege required", () => {
  it("withdraws the as-is button and says which rule withdrew it", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} requireLeastPrivilege={true} />);

    await check(user);

    // Removed, not disabled. A greyed-out control is still an offer, and the
    // reader's next move is to hunt for what unlocks it rather than to press the
    // button beside it that works.
    expect(
      screen.queryByRole("button", { name: "Use these credentials as-is" }),
    ).not.toBeInTheDocument();
    // The provisioning path is still there and is now the only one.
    expect(
      screen.getByRole("button", { name: "Create a scoped user and connect" }),
    ).toBeInTheDocument();
    // And its absence is explained, so nobody reads it as a missing feature.
    expect(screen.getByText(/Storing these as they are is not offered/)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Organization/)).toBeInTheDocument();
  });

  it("leaves the plain Connect button alone for credentials that are already scoped", async () => {
    // The rule is about credentials broader than the engine needs. A string that
    // cannot create users is exactly what it asks for, so this path must not be
    // narrowed by it — refusing here would leave an org with the rule on unable
    // to connect anything at all.
    checkConnection.mockResolvedValue(diagnosis({ canProvision: false }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} requireLeastPrivilege={true} />);

    await check(user);

    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByText(/Storing these as they are is not offered/)).not.toBeInTheDocument();
  });

  it("still offers the as-is button when no such rule is set", async () => {
    checkConnection.mockResolvedValue(diagnosis({ canProvision: true }));
    const user = userEvent.setup();
    renderInApp(<ConnectClusterForm plan={plan()} />);

    await check(user);

    expect(screen.getByRole("button", { name: "Use these credentials as-is" })).toBeInTheDocument();
  });
});

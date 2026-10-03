import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { NewPrivilegesBanner, NewPrivilegesSection } from "./new-privileges";

const upgradeClusterRole = vi.hoisted(() => vi.fn());
const reviewClusterPrivileges = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return {
    ...actual,
    api: () => overriding(actual.api(), { upgradeClusterRole, reviewClusterPrivileges }),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { anchorLink, overriding } = await import("~/lib/overriding");
  return overriding(actual, { Link: anchorLink });
});
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

const CLUSTER = "11111111-1111-4111-8111-111111111111";
const PROFILER = {
  key: "enableProfiler",
  label: "Turn the profiler on",
  enables: "the failed-operations check on clusters whose profiler is off",
  release: "0.29.0",
};
const COMMAND =
  'db.getSiblingDB("admin").grantPrivilegesToRole("indexterityEngine", [{"resource":{"db":"","collection":""},"actions":["enableProfiler"]}])';
const OURS = { pending: [PROFILER], command: COMMAND, canUpgrade: true };
const HANDMADE = { pending: [PROFILER], command: null, canUpgrade: false };
const NONE = { pending: [], command: null, canUpgrade: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NewPrivilegesBanner", () => {
  it("says nothing when nothing is new", () => {
    const { container } = renderInApp(
      <NewPrivilegesBanner clusterId={CLUSTER} newPrivileges={NONE} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // A notice and not a fault: nothing stopped working, and it says so first.
  it("names what is new and points at the settings page", () => {
    renderInApp(<NewPrivilegesBanner clusterId={CLUSTER} newPrivileges={OURS} />);
    expect(screen.getByText("New privileges Indexterity can use")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has stopped working without them/)).toBeInTheDocument();
    expect(screen.getByText("enableProfiler")).toBeInTheDocument();
    expect(screen.getByText(/new in 0\.29\.0/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Review them in this cluster's settings" }),
    ).toBeInTheDocument();
  });
});

describe("NewPrivilegesSection", () => {
  const render = (newPrivileges: typeof OURS | typeof HANDMADE) =>
    renderInApp(
      <NewPrivilegesSection clusterId={CLUSTER} newPrivileges={newPrivileges} onStale={vi.fn()} />,
    );

  it("hands over the statement, and the upgrade, where the role is ours", async () => {
    upgradeClusterRole.mockResolvedValue({ newPrivileges: NONE });
    render(OURS);
    expect(screen.getByText(COMMAND)).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Admin connection string"),
      "mongodb://root:pw@db.example:27017",
    );
    await userEvent.click(screen.getByRole("button", { name: "Upgrade role" }));
    expect(upgradeClusterRole).toHaveBeenCalledWith({
      clusterId: CLUSTER,
      adminConnectionString: "mongodb://root:pw@db.example:27017",
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Role upgraded — the stored credentials now hold every privilege",
    );
  });

  // The role changed but the credentials do not show it yet: a success, and the
  // notice stays up, so the reader is told why.
  it("says when the upgrade is not visible to the credentials yet", async () => {
    upgradeClusterRole.mockResolvedValue({ newPrivileges: OURS });
    render(OURS);
    await userEvent.type(screen.getByLabelText("Admin connection string"), "mongodb://root:pw@db");
    await userEvent.click(screen.getByRole("button", { name: "Upgrade role" }));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("do not show it yet"));
  });

  // #246: no command with a blank in it for a role somebody made by hand.
  it("points at the guide where the role was made by hand", () => {
    render(HANDMADE);
    expect(
      screen.getByText(/Add them to the role you created for Indexterity/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/grantPrivilegesToRole/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade role" })).not.toBeInTheDocument();
  });

  it("can be marked as reviewed without granting anything", async () => {
    reviewClusterPrivileges.mockResolvedValue({ newPrivileges: NONE });
    render(HANDMADE);
    await userEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));
    expect(reviewClusterPrivileges).toHaveBeenCalledWith({ clusterId: CLUSTER });
    expect(upgradeClusterRole).not.toHaveBeenCalled();
  });
});

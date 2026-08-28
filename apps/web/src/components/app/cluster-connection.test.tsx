import { ORPCError } from "@orpc/client";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, authOk, renderInApp } from "~/test-utils";
import { ClusterConnection } from "./cluster-connection";

const setClusterMode = vi.hoisted(() => vi.fn());
const getClusterPrivileges = vi.hoisted(() => vi.fn());
const rotateConnection = vi.hoisted(() => vi.fn());
const deleteCluster = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
const signInEmail = vi.hoisted(() => vi.fn());
const setActiveOrg = vi.hoisted(() => vi.fn());

// The api client, called straight from the mutation hooks. A refusal is a throw
// with a status on it, not an { ok: false } a server function handed back.
vi.mock("~/lib/api", () => ({
  api: () => ({ setClusterMode, rotateConnection, deleteCluster, getClusterPrivileges }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
// The re-auth dialog's half of the fresh-session flow (#52) goes through
// better-auth's client, not the api.
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    getSession,
    signIn: { email: signInEmail },
    organization: { setActive: setActiveOrg },
  },
}));

const cluster = {
  id: "c1",
  name: "Production",
  engine: "MONGODB",
  readOnly: true,
  provisionedUsername: null,
  revokeCommand: null,
  credentialPosture: "SCOPED",
} as const;

// One re-check of the stored credentials (#313). Reachable and clean by default,
// so the tests that are not about this panel never have to say so.
function privileges(over: Record<string, unknown> = {}) {
  return {
    clusterId: "c1",
    engine: "MONGODB",
    checkedAt: new Date().toISOString(),
    reachable: true,
    message: null,
    username: "idx_a91f",
    authEnabled: true,
    required: [
      {
        key: "listIndexes",
        label: "List indexes",
        enables: "reading index specs",
        tier: "CORE",
        granted: true,
        command: null,
      },
    ],
    surplus: [],
    ...over,
  };
}

// The api's refusal to act on a session older than the fresh window — the one
// failure the hooks turn into a password prompt instead of a toast.
function staleSession(): Error {
  return new ORPCError("SESSION_NOT_FRESH", { status: 403, message: "sign in again" });
}

beforeEach(() => {
  navigate.mockResolvedValue(undefined);
  setClusterMode.mockResolvedValue(cluster);
  rotateConnection.mockResolvedValue(cluster);
  deleteCluster.mockResolvedValue({ unhidden: 0, revokeCommand: null });
  getClusterPrivileges.mockResolvedValue(privileges());
  getSession.mockResolvedValue(
    authOk({ user: { email: "owner@example.com" }, session: { activeOrganizationId: null } }),
  );
  signInEmail.mockResolvedValue(authOk({}));
  setActiveOrg.mockResolvedValue(authOk({}));
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
    renderInApp(
      <ClusterConnection
        cluster={{
          ...cluster,
          provisionedUsername: "idx_abc",
          revokeCommand: 'db.getSiblingDB("admin").dropUser("idx_abc")',
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/dropUser\("idx_abc"\)/)).toBeInTheDocument();
  });

  // #338: this dialog used to compose MongoDB's dropUser itself, so a PostgreSQL
  // or SQL Server owner was told to run it against a server that has never heard
  // of db.getSiblingDB. It now prints whatever the api's adapter answered.
  it("shows the engine's own statements, not MongoDB's, on a PostgreSQL cluster", async () => {
    const user = userEvent.setup();
    const command = '\\c "appdb"\nDROP OWNED BY "indexterity";\nDROP ROLE "indexterity";';
    renderInApp(
      <ClusterConnection
        cluster={{
          ...cluster,
          engine: "POSTGRESQL",
          provisionedUsername: "indexterity",
          revokeCommand: command,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const shown = await screen.findByText(/DROP OWNED BY/);
    expect(shown).toBeInTheDocument();
    expect(shown.textContent).toContain('DROP ROLE "indexterity";');
    expect(screen.queryByText(/getSiblingDB/)).not.toBeInTheDocument();
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

  // The fresh-session tier (#52): SESSION_NOT_FRESH is the one refusal the
  // reader can fix in place, so it opens a password prompt instead of a toast —
  // and the action re-fires on its own once the sign-in lands.
  it("asks for the password on a stale session, then re-fires the action", async () => {
    setClusterMode.mockRejectedValueOnce(staleSession()).mockResolvedValueOnce(cluster);
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await confirm(user, "Go live", "Go live");

    expect(await screen.findByText(/Confirm it's you/)).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(signInEmail).toHaveBeenCalledWith({
      email: "owner@example.com",
      password: "hunter2hunter2",
    });
    expect(setClusterMode).toHaveBeenCalledTimes(2);
    expect(setClusterMode).toHaveBeenLastCalledWith({ clusterId: "c1", readOnly: false });
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Live mode enabled"));
  });

  it("carries the active org onto the re-authenticated session", async () => {
    getSession.mockResolvedValue(
      authOk({ user: { email: "owner@example.com" }, session: { activeOrganizationId: "org-2" } }),
    );
    deleteCluster
      .mockRejectedValueOnce(staleSession())
      .mockResolvedValueOnce({ unhidden: 0, revokeCommand: null });
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await confirm(user, "Disconnect", "Disconnect");
    await user.type(await screen.findByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    // Without this, the new session would fall back to the oldest membership
    // and the retried disconnect would 404 on a cluster the reader was looking
    // at moments ago.
    expect(setActiveOrg).toHaveBeenCalledWith({ organizationId: "org-2" });
    expect(deleteCluster).toHaveBeenCalledTimes(2);
  });

  it("shows the refusal and keeps the prompt open on a wrong password", async () => {
    setClusterMode.mockRejectedValue(staleSession());
    signInEmail.mockResolvedValue({ data: null, error: { message: "invalid password" } });
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await confirm(user, "Go live", "Go live");
    await user.type(await screen.findByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("invalid password")).toBeInTheDocument();
    expect(setClusterMode).toHaveBeenCalledTimes(1);
  });

  it("cancelling the password prompt retries nothing", async () => {
    setClusterMode.mockRejectedValue(staleSession());
    const user = userEvent.setup();
    renderInApp(<ClusterConnection cluster={cluster} />);

    await confirm(user, "Go live", "Go live");
    await screen.findByText(/Confirm it's you/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(signInEmail).not.toHaveBeenCalled();
    expect(setClusterMode).toHaveBeenCalledTimes(1);
  });
});

// What the credentials COULD do, which is a different question from what
// read-only ALLOWS them to — a cluster can be read-only and still be held on a
// string that could drop a table.
describe("ClusterConnection — credential posture", () => {
  it("names an admin string as one that can do more than manage indexes", () => {
    renderInApp(<ClusterConnection cluster={{ ...cluster, credentialPosture: "ADMIN" }} />);
    expect(screen.getByText("admin credentials")).toBeInTheDocument();
    expect(screen.getByText(/more than manage indexes/)).toBeInTheDocument();
  });

  // The only case whose ceiling is known exactly, because we set it.
  it("says a provisioned user's ceiling is known", () => {
    renderInApp(<ClusterConnection cluster={{ ...cluster, credentialPosture: "PROVISIONED" }} />);
    expect(screen.getByText("scoped user")).toBeInTheDocument();
    expect(screen.getByText(/known exactly/)).toBeInTheDocument();
  });

  it("does not claim to know the exact grants of a pasted scoped string", () => {
    renderInApp(<ClusterConnection cluster={{ ...cluster, credentialPosture: "SCOPED" }} />);
    expect(screen.getByText("scoped credentials")).toBeInTheDocument();
    expect(screen.getByText(/yours rather than ours to state/)).toBeInTheDocument();
  });

  // Null is its own case, not the narrowest one. Folding "we never asked" into
  // "scoped" is how a reassuring badge gets attached to an admin string.
  it("says it was never recorded rather than guessing the narrowest", () => {
    renderInApp(<ClusterConnection cluster={{ ...cluster, credentialPosture: null }} />);
    expect(screen.getByText("posture not recorded")).toBeInTheDocument();
    expect(screen.queryByText("scoped credentials")).not.toBeInTheDocument();
    expect(screen.getByText(/Rotating the connection string records it/)).toBeInTheDocument();
  });
});

// #313. The panel behind the posture badge: which privileges, not just how many.
describe("ClusterConnection privileges panel", () => {
  it("does not dial the cluster until the reader asks", async () => {
    renderInApp(<ClusterConnection cluster={cluster} />);
    // The read costs a connection to somebody's production database, so a
    // settings page view must not spend one for a panel most visits never open.
    expect(getClusterPrivileges).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Check what these credentials hold" }),
    );
    expect(getClusterPrivileges).toHaveBeenCalledWith({ clusterId: "c1" });
  });

  it("says the redundant group is empty rather than drawing nothing", async () => {
    renderInApp(<ClusterConnection cluster={cluster} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Check what these credentials hold" }),
    );
    // The issue's second constraint, and #289's rule: nothing surplus is the
    // REASSURING answer, and blank space under a heading does not deliver
    // reassurance — it reads as a panel that failed to load.
    expect(
      await screen.findByText(/hold no privilege the engine does not use/),
    ).toBeInTheDocument();
  });

  it("names each surplus grant and the statement that removes it", async () => {
    getClusterPrivileges.mockResolvedValue(
      privileges({
        surplus: [
          {
            key: "surplus_root",
            label: "root",
            enables: "everything on the deployment",
            tier: "SURPLUS",
            granted: true,
            command: 'db.getSiblingDB("admin").revokeRolesFromUser("admin", [])',
          },
        ],
      }),
    );
    renderInApp(<ClusterConnection cluster={cluster} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Check what these credentials hold" }),
    );
    // Twice on purpose, and that is the three-group shape rather than a bug: a
    // surplus grant IS something these credentials provide, and it is also the
    // one thing on the card a reader can act on. The badge says "can do more than
    // manage indexes" and gives them no target; this is the target.
    expect(await screen.findAllByText("root")).toHaveLength(2);
    expect(screen.getByText(/revokeRolesFromUser/)).toBeInTheDocument();
    expect(screen.getByText(/Held and never used/)).toBeInTheDocument();
  });

  it("says a failed re-check failed instead of showing an empty redundant group", async () => {
    getClusterPrivileges.mockResolvedValue(
      privileges({ reachable: false, message: "cluster unreachable", required: [], surplus: [] }),
    );
    renderInApp(<ClusterConnection cluster={cluster} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Check what these credentials hold" }),
    );
    // "We could not ask" and "there is nothing surplus" are the two answers that
    // must never render alike, and the second is the one that reassures (#289).
    expect(await screen.findByText("Could not re-check these credentials")).toBeInTheDocument();
    expect(screen.queryByText(/hold no privilege the engine does not use/)).not.toBeInTheDocument();
  });
});

// #313, part one's other half: a cluster sealed before the org turned the rule on.
describe("ClusterConnection least-privilege policy", () => {
  it("says nothing about policy when the org has not asked for it", () => {
    renderInApp(<ClusterConnection cluster={{ ...cluster, credentialPosture: "ADMIN" }} />);
    expect(screen.queryByText("Out of policy for this organization")).not.toBeInTheDocument();
  });

  it("marks an admin-string cluster out of policy, and promises analysis continues", () => {
    renderInApp(
      <ClusterConnection
        cluster={{ ...cluster, credentialPosture: "ADMIN" }}
        requireLeastPrivilege={true}
      />,
    );
    expect(screen.getByText("Out of policy for this organization")).toBeInTheDocument();
    // The fear that stops people switching the setting on. Saying it here is what
    // makes the marker safe to show at all.
    expect(screen.getByText(/Analysis keeps running/)).toBeInTheDocument();
  });

  it("leaves a provisioned or scoped cluster alone", () => {
    for (const posture of ["PROVISIONED", "SCOPED"] as const) {
      const { unmount } = renderInApp(
        <ClusterConnection
          cluster={{ ...cluster, credentialPosture: posture }}
          requireLeastPrivilege={true}
        />,
      );
      expect(screen.queryByText("Out of policy for this organization")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("treats an unrecorded posture as its own case, not as compliant", () => {
    renderInApp(
      <ClusterConnection
        cluster={{ ...cluster, credentialPosture: null }}
        requireLeastPrivilege={true}
      />,
    );
    // "We never asked" is not "scoped". The remedy differs too — rotating RECORDS
    // the posture, and may record that it was fine all along — so it gets its own
    // sentence rather than the violation's.
    expect(
      screen.getByText("Posture unknown, and this organization requires least privilege"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Out of policy for this organization")).not.toBeInTheDocument();
  });

  // The field said `mongodb://` on every cluster, including the ones that are
  // not MongoDB — a credential field confidently naming the wrong dialect at the
  // moment somebody is pasting a secret into it.
  it("names the dialect of the cluster in front of the reader", async () => {
    const user = userEvent.setup();

    for (const [engine, expected] of [
      ["MONGODB", "mongodb://"],
      ["POSTGRESQL", "postgres://"],
      ["MSSQL", "mssql:// or Server=…"],
    ] as const) {
      const { unmount } = renderInApp(<ClusterConnection cluster={{ ...cluster, engine }} />);
      await user.click(screen.getByRole("button", { name: "Rotate string" }));

      expect(screen.getByLabelText("New connection string")).toHaveAttribute(
        "placeholder",
        `new ${expected} connection string (verified before stored)`,
      );
      unmount();
    }
  });

  // Every action on this card changes something on somebody's database, and none
  // of them said anything while it was in flight: the button stayed live, so a
  // second press was a second request. The rotation is the worst of them — it
  // DIALS the customer's cluster to verify, which through a VPN is seconds.
  describe("while an action is in flight", () => {
    // A promise that never settles, so the mutation stays pending for the
    // assertions rather than racing them.
    const never = () => new Promise(() => {});

    it("blocks the mode switch and says what it is doing", async () => {
      setClusterMode.mockImplementation(never);
      const user = userEvent.setup();
      renderInApp(<ClusterConnection cluster={{ ...cluster, readOnly: false }} />);

      await user.click(screen.getByRole("button", { name: "Make read-only" }));

      const button = await screen.findByRole("button", { name: "Switching…" });
      expect(button).toBeDisabled();
      expect(setClusterMode).toHaveBeenCalledTimes(1);
    });

    it("blocks the rotation, which is the longest wait here", async () => {
      rotateConnection.mockImplementation(never);
      const user = userEvent.setup();
      renderInApp(<ClusterConnection cluster={cluster} />);

      await user.click(screen.getByRole("button", { name: "Rotate string" }));
      await user.type(
        screen.getByLabelText("New connection string"),
        "mongodb://user:pass@host:27017",
      );
      await user.click(screen.getByRole("button", { name: "Save" }));

      const button = await screen.findByRole("button", { name: "Verifying…" });
      expect(button).toBeDisabled();
      expect(rotateConnection).toHaveBeenCalledTimes(1);
    });

    // The irreversible one. A second confirm used to fire a second delete, and
    // the second answers "no such cluster" — an error about the reader's own
    // successful action.
    it("blocks the disconnect trigger once it has been confirmed", async () => {
      deleteCluster.mockImplementation(never);
      const user = userEvent.setup();
      renderInApp(<ClusterConnection cluster={cluster} />);

      await user.click(screen.getByRole("button", { name: "Disconnect" }));
      // Both the trigger and the dialog's action are called "Disconnect", so the
      // confirm is taken from inside the dialog.
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

      // The dialog is gone and the trigger is where the reader now looks.
      const trigger = await screen.findByRole("button", { name: "Disconnecting…" });
      expect(trigger).toBeDisabled();

      await user.click(trigger);
      expect(deleteCluster).toHaveBeenCalledTimes(1);
    });
  });
});

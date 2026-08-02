import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { TeamSection } from "./team-section";

const acceptInvite = vi.hoisted(() => vi.fn());
const createInvite = vi.hoisted(() => vi.fn());
const leaveOrg = vi.hoisted(() => vi.fn());
const removeMember = vi.hoisted(() => vi.fn());
const renameOrg = vi.hoisted(() => vi.fn());
const setMemberRole = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("~/lib/app-server", () => ({
  acceptInvite,
  createInvite,
  leaveOrg,
  removeMember,
  renameOrg,
  setMemberRole,
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const org = {
  name: "Acme",
  plan: {
    plan: "FREE",
    maxClusters: 1,
    maxMembers: 3,
    workloadAnalysis: false,
    clustersUsed: 0,
    membersUsed: 3,
  },
  members: [
    { userId: "u1", email: "owner@acme.test", name: "Owner One", role: "owner" },
    { userId: "u2", email: "member@acme.test", name: "Member Two", role: "member" },
  ],
  pendingInvites: [
    { email: "pending@acme.test", role: "member", expiresAt: "2026-09-01T00:00:00Z" },
  ],
};

function row(email: string): HTMLElement {
  const item = screen.getByText(`(${email})`).closest("li");
  if (item === null) throw new Error(`no row for ${email}`);
  return item;
}

beforeEach(() => {
  renameOrg.mockResolvedValue({ ok: true });
  setMemberRole.mockResolvedValue({ ok: true });
  removeMember.mockResolvedValue({ ok: true });
  leaveOrg.mockResolvedValue({ ok: true });
  createInvite.mockResolvedValue({ token: "inv_123" });
  acceptInvite.mockResolvedValue({ ok: true, message: "joined Acme" });
});

describe("TeamSection", () => {
  it("distinguishes members from people who have only been invited", () => {
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);
    expect(screen.getByText("(owner@acme.test)")).toBeInTheDocument();
    expect(screen.getByText("pending@acme.test")).toBeInTheDocument();
    expect(screen.getByText("invited · member")).toBeInTheDocument();
  });

  // The button has to offer the OPPOSITE of the current role; offering the
  // one they already have would be a no-op the reader could not diagnose.
  it("offers to promote a member and demote an owner", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Make owner" }));
    expect(setMemberRole).toHaveBeenCalledWith({ data: { userId: "u2", role: "owner" } });

    await user.click(within(row("owner@acme.test")).getByRole("button", { name: "Make member" }));
    expect(setMemberRole).toHaveBeenCalledWith({ data: { userId: "u1", role: "member" } });
  });

  // The api refuses to demote the last owner. Its reason is the useful one —
  // a generic "failed" would leave the reader guessing.
  it("shows the api's reason when a role change is refused", async () => {
    setMemberRole.mockResolvedValue({ ok: false, message: "an org must keep one owner" });
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.click(within(row("owner@acme.test")).getByRole("button", { name: "Make member" }));
    expect(toastError).toHaveBeenCalledWith("an org must keep one owner");
  });

  it("asks before removing someone, and names them", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove member@acme.test?")).toBeInTheDocument();
    expect(removeMember).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove", hidden: false }));
    expect(removeMember).toHaveBeenCalledWith({ data: "u2" });
  });

  it("asks before leaving the org", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Leave org" }));
    expect(await screen.findByText("Leave Acme?")).toBeInTheDocument();
    expect(leaveOrg).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(leaveOrg).toHaveBeenCalled();
  });

  // The token is shown once and never again — losing it means re-inviting.
  it("shows the invite token so it can be passed on", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.type(screen.getByLabelText("Invite a teammate"), "new@acme.test");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(createInvite).toHaveBeenCalledWith({ data: "new@acme.test" });
    expect(await screen.findByText("inv_123")).toBeInTheDocument();
  });

  it("reports why an invite token was not accepted", async () => {
    acceptInvite.mockResolvedValue({ ok: false, message: "invite expired" });
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderInApp(<TeamSection org={org} onChanged={onChanged} />);

    await user.type(screen.getByLabelText("Have an invite token?"), "old_token");
    await user.click(screen.getByRole("button", { name: "Join org" }));

    expect(await screen.findByText("invite expired")).toBeInTheDocument();
    // Nothing changed, so the page must not be told to reload as if it had.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("renames the org from the current name, not a stale draft", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const field = screen.getByLabelText("Organization name");
    expect(field).toHaveValue("Acme");

    await user.clear(field);
    await user.type(field, "Acme Two");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(renameOrg).toHaveBeenCalledWith({ data: "Acme Two" });
    expect(toastSuccess).toHaveBeenCalledWith("Org renamed");
  });

  it("says who can rename when the api refuses", async () => {
    renameOrg.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("owner only"));
  });

  // A limit nobody can see until they hit it turns into a support email.
  it("shows the plan and what is left of it", () => {
    renderInApp(<TeamSection org={org} onChanged={vi.fn()} />);
    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText(/0 \/ 1 clusters/)).toBeInTheDocument();
    expect(screen.getByText(/3 \/ 3 seats/)).toBeInTheDocument();
    expect(screen.getByText(/index suggestions not included/)).toBeInTheDocument();
  });

  it("shows a bare count where the plan has no cap", () => {
    renderInApp(
      <TeamSection
        org={{
          ...org,
          plan: {
            ...org.plan,
            plan: "SCALE",
            maxClusters: null,
            maxMembers: null,
            workloadAnalysis: true,
          },
        }}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/0 clusters/)).toBeInTheDocument();
    expect(screen.queryByText(/not included/)).not.toBeInTheDocument();
  });
});

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { TeamSection } from "./team-section";

const acceptInvite = vi.hoisted(() => vi.fn());
const createInvite = vi.hoisted(() => vi.fn());
const leaveOrg = vi.hoisted(() => vi.fn());
const removeMember = vi.hoisted(() => vi.fn());
const renameOrg = vi.hoisted(() => vi.fn());
const setMemberRole = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// The api client, called straight from the mutation hooks. Refusals arrive as
// throws carrying a status, which is what decides whether the api's own reason
// is shown or a generic one is.
vi.mock("~/lib/api", () => ({
  api: () => ({ acceptInvite, createInvite, leaveOrg, removeMember, renameOrg, setMemberRole }),
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const org = {
  name: "Acme",
  plan: {
    plan: "FREE",
    maxClusters: 1,
    maxMembers: 3,
    workloadAnalysis: true,
    autoApply: false,
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
  renameOrg.mockResolvedValue({ id: "o1", name: "Acme" });
  setMemberRole.mockResolvedValue({ userId: "u2", role: "owner" });
  removeMember.mockResolvedValue({ removed: true });
  leaveOrg.mockResolvedValue({ left: true });
  createInvite.mockResolvedValue({ token: "inv_123", email: "new@acme.test", role: "member" });
  acceptInvite.mockResolvedValue({ orgId: "o2", orgName: "Acme" });
});

describe("TeamSection", () => {
  it("distinguishes members from people who have only been invited", () => {
    renderInApp(<TeamSection org={org} />);
    expect(screen.getByText("(owner@acme.test)")).toBeInTheDocument();
    expect(screen.getByText("pending@acme.test")).toBeInTheDocument();
    expect(screen.getByText("invited · member")).toBeInTheDocument();
  });

  // The button has to offer the OPPOSITE of the current role; offering the
  // one they already have would be a no-op the reader could not diagnose.
  it("offers to promote a member and demote an owner", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Make owner" }));
    expect(setMemberRole).toHaveBeenCalledWith({ userId: "u2", role: "owner" });

    await user.click(within(row("owner@acme.test")).getByRole("button", { name: "Make member" }));
    expect(setMemberRole).toHaveBeenCalledWith({ userId: "u1", role: "member" });
  });

  // The api refuses to demote the last owner. Its reason is the useful one —
  // a generic "failed" would leave the reader guessing.
  it("shows the api's reason when a role change is refused", async () => {
    setMemberRole.mockRejectedValue(apiError(409, "an org must keep one owner"));
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.click(within(row("owner@acme.test")).getByRole("button", { name: "Make member" }));
    expect(toastError).toHaveBeenCalledWith("an org must keep one owner");
  });

  it("asks before removing someone, and names them", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove member@acme.test?")).toBeInTheDocument();
    expect(removeMember).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove", hidden: false }));
    expect(removeMember).toHaveBeenCalledWith({ userId: "u2" });
  });

  it("asks before leaving the org", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.click(screen.getByRole("button", { name: "Leave org" }));
    expect(await screen.findByText("Leave Acme?")).toBeInTheDocument();
    expect(leaveOrg).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(leaveOrg).toHaveBeenCalled();
  });

  // The token is shown once and never again — losing it means re-inviting.
  it("shows the invite token so it can be passed on", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.type(screen.getByLabelText("Invite a teammate"), "new@acme.test");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(createInvite).toHaveBeenCalledWith({ email: "new@acme.test", role: "member" });
    expect(await screen.findByText("inv_123")).toBeInTheDocument();
  });

  it("reports why an invite token was not accepted", async () => {
    acceptInvite.mockRejectedValue(apiError(404, "invite expired"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.type(screen.getByLabelText("Have an invite token?"), "old_token");
    await user.click(screen.getByRole("button", { name: "Join org" }));

    expect(await screen.findByText("invite expired")).toBeInTheDocument();
    // Still in the same org, so nothing may be thrown away.
    expect(invalidate).not.toHaveBeenCalled();
  });

  // Joining lands the caller in a different org, so the answer to every other
  // question on every other page changed too — not just this member list.
  it("treats joining another org as more than an org change", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const remove = vi.spyOn(queryClient, "removeQueries");

    await user.type(screen.getByLabelText("Have an invite token?"), "good_token");
    await user.click(screen.getByRole("button", { name: "Join org" }));

    expect(await screen.findByText("joined Acme")).toBeInTheDocument();
    // The whole cache, not the shell key: the api resolves a different
    // membership from here on, so every cached answer is about the old org.
    expect(invalidate).toHaveBeenCalledWith();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["shell"] });
    // And what is not mounted is dropped, or the next loader would render it.
    expect(remove).toHaveBeenCalledWith({ type: "inactive" });
  });

  it("does the same on the way out", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Leave org" }));
    await user.click(await screen.findByRole("button", { name: "Leave" }));

    expect(invalidate).toHaveBeenCalledWith();
  });

  // Renaming, inviting and role changes stay inside this org, so they move the
  // one key the member list is drawn from — not the whole cache.
  it("refetches only the shell when something inside the org changes", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Make owner" }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["shell"] });
  });

  // An invite that was refused used to leave the reader looking at a form that
  // had visibly done nothing at all.
  it("says so when an invite could not be created", async () => {
    createInvite.mockRejectedValue(apiError(402, "seat limit reached"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.type(screen.getByLabelText("Invite a teammate"), "new@acme.test");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("seat limit"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("renames the org from the current name, not a stale draft", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const field = screen.getByLabelText("Organization name");
    expect(field).toHaveValue("Acme");

    await user.clear(field);
    await user.type(field, "Acme Two");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(renameOrg).toHaveBeenCalledWith({ name: "Acme Two" });
    expect(toastSuccess).toHaveBeenCalledWith("Org renamed");
  });

  it("says who can rename when the api refuses", async () => {
    renameOrg.mockRejectedValue(apiError(403, "owner only"));
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} />);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("owner only"));
  });

  // A limit nobody can see until they hit it turns into a support email.
  it("shows the plan and what is left of it", () => {
    renderInApp(<TeamSection org={org} />);
    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText(/0 \/ 1 clusters/)).toBeInTheDocument();
    expect(screen.getByText(/3 \/ 3 seats/)).toBeInTheDocument();
    expect(screen.getByText(/changes need your approval/)).toBeInTheDocument();
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
            autoApply: true,
          },
        }}
      />,
    );
    expect(screen.getByText(/0 clusters/)).toBeInTheDocument();
    expect(screen.queryByText(/need your approval/)).not.toBeInTheDocument();
  });
});

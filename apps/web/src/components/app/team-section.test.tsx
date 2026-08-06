import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authError, authOk, renderInApp } from "~/test-utils";
import { TeamSection } from "./team-section";

const acceptInvitation = vi.hoisted(() => vi.fn());
const cancelInvitation = vi.hoisted(() => vi.fn());
const deleteOrg = vi.hoisted(() => vi.fn());
const inviteMember = vi.hoisted(() => vi.fn());
const leave = vi.hoisted(() => vi.fn());
const rejectInvitation = vi.hoisted(() => vi.fn());
const removeMember = vi.hoisted(() => vi.fn());
const createOrg = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const updateMemberRole = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

// better-auth's client, called straight from the mutation hooks — these are its
// endpoints now, not the api's. A refusal arrives as a RESOLVED `{ data, error }`
// rather than a throw, which is the whole reason mutations/org.ts has an
// `unwrap`: a promise that never rejects has no onError.
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    organization: {
      acceptInvitation,
      cancelInvitation,
      create: createOrg,
      delete: deleteOrg,
      inviteMember,
      leave,
      rejectInvitation,
      removeMember,
      update,
      updateMemberRole,
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const org = {
  id: "o1",
  name: "Acme",
  role: "owner",
  plan: {
    plan: "FREE",
    maxClusters: 1,
    maxMembers: 3,
    workloadAnalysis: true,
    autoApply: false,
    clustersUsed: 0,
    membersUsed: 3,
    maxOrgs: 1,
    orgsUsed: 1,
  },
  members: [
    { memberId: "m1", userId: "u1", email: "owner@acme.test", name: "Owner One", role: "owner" },
    { memberId: "m2", userId: "u2", email: "member@acme.test", name: "Member Two", role: "member" },
  ],
  pendingInvites: [
    { id: "i1", email: "pending@acme.test", role: "member", expiresAt: "2026-09-01T00:00:00Z" },
  ],
  provisionedUsers: [],
};

const invitesToMe = [
  { id: "i9", orgName: "Other Co", role: "member", expiresAt: "2026-09-01T00:00:00Z" },
];

function row(email: string): HTMLElement {
  const item = screen.getByText(`(${email})`).closest("li");
  if (item === null) throw new Error(`no row for ${email}`);
  return item;
}

beforeEach(() => {
  vi.clearAllMocks();
  createOrg.mockResolvedValue(authOk({ id: "o2", name: "Second Co" }));
  update.mockResolvedValue(authOk({ id: "o1", name: "Acme" }));
  updateMemberRole.mockResolvedValue(authOk({ id: "m2", role: "owner" }));
  removeMember.mockResolvedValue(authOk({ member: { id: "m2" } }));
  leave.mockResolvedValue(authOk({ id: "m1" }));
  deleteOrg.mockResolvedValue(authOk({ id: "o1" }));
  inviteMember.mockResolvedValue(authOk({ id: "i2", email: "new@acme.test", role: "member" }));
  cancelInvitation.mockResolvedValue(authOk({ id: "i1" }));
  acceptInvitation.mockResolvedValue(authOk({ invitation: { id: "i9" }, member: { id: "m9" } }));
  rejectInvitation.mockResolvedValue(authOk({ invitation: { id: "i9" } }));
});

describe("TeamSection", () => {
  it("distinguishes members from people who have only been invited", () => {
    renderInApp(<TeamSection org={org} invites={[]} />);
    expect(screen.getByText("(owner@acme.test)")).toBeInTheDocument();
    expect(screen.getByText("pending@acme.test")).toBeInTheDocument();
    expect(screen.getByText("invited · member")).toBeInTheDocument();
  });

  // The button has to offer the OPPOSITE of the current role; offering the
  // one they already have would be a no-op the reader could not diagnose.
  //
  // Keyed on the MEMBERSHIP id, not the user id: one person can be a member of
  // several orgs, and the plugin's endpoint asks which membership.
  it("offers to promote a member and demote an owner", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Make owner" }));
    expect(updateMemberRole).toHaveBeenCalledWith({ memberId: "m2", role: "owner" });

    await user.click(within(row("owner@acme.test")).getByRole("button", { name: "Make member" }));
    expect(updateMemberRole).toHaveBeenCalledWith({ memberId: "m1", role: "member" });
  });

  // The plugin refuses to demote the last owner. Its reason is the useful one —
  // a generic "failed" would leave the reader guessing.
  it("shows the reason when a role change is refused", async () => {
    updateMemberRole.mockResolvedValue(authError(400, "an org must keep one owner"));
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.click(within(row("owner@acme.test")).getByRole("button", { name: "Make member" }));
    expect(toastError).toHaveBeenCalledWith("an org must keep one owner");
  });

  it("asks before removing someone, and names them", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove member@acme.test?")).toBeInTheDocument();
    expect(removeMember).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove", hidden: false }));
    expect(removeMember).toHaveBeenCalledWith({ memberIdOrEmail: "m2" });
  });

  it("asks before leaving the org", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.click(screen.getByRole("button", { name: "Leave org" }));
    expect(await screen.findByText("Leave Acme?")).toBeInTheDocument();
    expect(leave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(leave).toHaveBeenCalledWith({ organizationId: "o1" });
  });

  // Deleting an org takes the clusters, the history and the memberships with it,
  // and one click-through dialog is answered by the part of you that has
  // answered forty of them today.
  it("will not delete an org until its name is typed out", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.click(screen.getByRole("button", { name: "Delete org" }));
    expect(await screen.findByText("Delete Acme?")).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Delete this organization" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/Type/), "Acmm");
    expect(confirm).toBeDisabled();

    await user.clear(screen.getByLabelText(/Type/));
    await user.type(screen.getByLabelText(/Type/), "Acme");
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(deleteOrg).toHaveBeenCalledWith({ organizationId: "o1" });
  });

  // Cascades take our rows and touch nothing on the customer's servers. After
  // the org is gone there is no record of which user is on which cluster, so
  // this is the last moment it can be said.
  it("names the provisioned users the deletion cannot revoke", async () => {
    const user = userEvent.setup();
    renderInApp(
      <TeamSection
        org={{
          ...org,
          provisionedUsers: [
            {
              cluster: "Prod",
              username: "indexterity_ro",
              revokeCommand: 'db.getSiblingDB("admin").dropUser("indexterity_ro")',
            },
          ],
        }}
        invites={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete org" }));
    expect(await screen.findByText("Prod")).toBeInTheDocument();
    expect(
      screen.getByText('db.getSiblingDB("admin").dropUser("indexterity_ro")'),
    ).toBeInTheDocument();
  });

  // No token comes back and none is shown: the invitation is addressed, and
  // only that address can accept it.
  it("sends an invitation without handing back a credential", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.type(screen.getByLabelText("Invite a teammate"), "new@acme.test");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(inviteMember).toHaveBeenCalledWith({ email: "new@acme.test", role: "member" });
    expect(await screen.findByText("Invitation sent")).toBeInTheDocument();
    expect(screen.getByText(/new@acme.test can join/)).toBeInTheDocument();
  });

  // Joining lands the caller in a different org, so the answer to every other
  // question on every other page changed too — not just this member list.
  it("treats joining another org as more than an org change", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} invites={invitesToMe} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const remove = vi.spyOn(queryClient, "removeQueries");

    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(acceptInvitation).toHaveBeenCalledWith({ invitationId: "i9" });
    // The whole cache, not one key: a different org answers everything from
    // here on, so every cached answer is about the old one.
    expect(invalidate).toHaveBeenCalledWith();
    await screen.findByText("Other Co", { exact: false });
    // And what is not mounted is dropped, or the next loader would render it.
    expect(remove).toHaveBeenCalledWith({ type: "inactive" });
  });

  it("reports why an invitation could not be accepted", async () => {
    acceptInvitation.mockResolvedValue(authError(400, "invitation expired"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} invites={invitesToMe} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(toastError).toHaveBeenCalledWith("invitation expired");
    // Still in the same org, so nothing may be thrown away.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does the same on the way out", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} invites={[]} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Leave org" }));
    await user.click(await screen.findByRole("button", { name: "Leave" }));

    expect(invalidate).toHaveBeenCalledWith();
  });

  // Inviting and role changes stay inside this org, so they move the one key the
  // member list is drawn from — not the whole cache, and not the cluster list.
  it("refetches only the org when something inside it changes", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} invites={[]} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(within(row("member@acme.test")).getByRole("button", { name: "Make owner" }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["org"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["clusters"] });
  });

  // A rename is the exception: the name is drawn twice, in the card's title from
  // the active org and in the switcher from the list of the caller's orgs.
  // Invalidating one left the other showing the old name.
  it("refetches both the org and the org list on a rename", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} invites={[]} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Organization name"));
    await user.type(screen.getByLabelText("Organization name"), "Renamed Co");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["org"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] });
  });

  // An invite that was refused used to leave the reader looking at a form that
  // had visibly done nothing at all.
  it("says so when an invitation could not be sent", async () => {
    inviteMember.mockResolvedValue(authError(402, "the FREE plan allows 3 members"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<TeamSection org={org} invites={[]} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.type(screen.getByLabelText("Invite a teammate"), "new@acme.test");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("3 members"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("renames the org from the current name, not a stale draft", async () => {
    const user = userEvent.setup();
    renderInApp(<TeamSection org={org} invites={[]} />);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const field = screen.getByLabelText("Organization name");
    expect(field).toHaveValue("Acme");

    await user.clear(field);
    await user.type(field, "Acme Two");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(update).toHaveBeenCalledWith({ data: { name: "Acme Two" } });
    expect(toastSuccess).toHaveBeenCalledWith("Org renamed");
  });

  // Owner-only controls are the plugin's rule; drawing them for a member would
  // be offering a button whose only outcome is a 403.
  it("hides every owner-only control from a member", () => {
    renderInApp(<TeamSection org={{ ...org, role: "member" }} invites={[]} />);
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete org" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Invite a teammate")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make owner" })).not.toBeInTheDocument();
    // Leaving is not owner-only — the last owner is stopped by the plugin, not
    // by hiding the button from everybody.
    expect(screen.getByRole("button", { name: "Leave org" })).toBeInTheDocument();
  });

  // The create screen only appears to somebody who belongs to nowhere, so
  // without this a plan that allows five orgs offers exactly one.
  it("lets a reader with room start another organization", async () => {
    const user = userEvent.setup();
    renderInApp(
      <TeamSection
        org={{ ...org, plan: { ...org.plan, plan: "PRO", maxOrgs: 5, orgsUsed: 1 } }}
        invites={[]}
      />,
    );

    await user.type(screen.getByLabelText("Start another organization"), "Second Co");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(createOrg).toHaveBeenCalledWith({ name: "Second Co", slug: "second-co" });
  });

  // At the cap it says which plan and what to do, rather than offering a field
  // whose only outcome is a 402.
  it("explains the org cap instead of offering a form that would be refused", () => {
    renderInApp(<TeamSection org={org} invites={[]} />);
    expect(screen.queryByLabelText("Start another organization")).not.toBeInTheDocument();
    expect(screen.getByText(/FREE plan allows 1 organization per person/)).toBeInTheDocument();
  });

  // Your own allowance, not this org's — a member of somebody else's org may
  // still make their own.
  it("offers it to a member too", () => {
    renderInApp(
      <TeamSection
        org={{ ...org, role: "member", plan: { ...org.plan, maxOrgs: 5, orgsUsed: 1 } }}
        invites={[]}
      />,
    );
    expect(screen.getByLabelText("Start another organization")).toBeInTheDocument();
  });

  // A limit nobody can see until they hit it turns into a support email.
  it("shows the plan and what is left of it", () => {
    renderInApp(<TeamSection org={org} invites={[]} />);
    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText(/0 \/ 1 clusters/)).toBeInTheDocument();
    expect(screen.getByText(/3 \/ 3 seats/)).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 1 orgs/)).toBeInTheDocument();
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
        invites={[]}
      />,
    );
    expect(screen.getByText(/0 clusters/)).toBeInTheDocument();
    expect(screen.queryByText(/need your approval/)).not.toBeInTheDocument();
  });
});

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authError, authOk, renderInApp } from "~/test-utils";
import { OrgList } from "./org-list";

const acceptInvitation = vi.hoisted(() => vi.fn());
const createOrg = vi.hoisted(() => vi.fn());
const rejectInvitation = vi.hoisted(() => vi.fn());
const setActive = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

// better-auth's client, called straight from the mutation hooks. A refusal
// arrives as a RESOLVED `{ data, error }` rather than a throw, which is why
// mutations/org.ts has an `unwrap`: a promise that never rejects has no
// onError.
// The real client with only the calls these tests make replaced. A factory
// returning a bare `{ authClient: { … } }` swaps the WHOLE module and leaves the
// rest of better-auth's client undefined, and nothing checked the replacements
// against the methods they stand in for.
vi.mock("~/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth-client")>();
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      organization: {
        ...actual.authClient.organization,
        acceptInvitation,
        create: createOrg,
        rejectInvitation,
        setActive,
      },
    },
  };
});
// The real sonner with two of `toast`'s methods replaced, rather than an object
// named `toast`. A factory returning `{ toast: { success, error } }` swaps the
// WHOLE module — `Toaster` and every other export become undefined — and the two
// functions were checked against nothing. Built on a copy so sonner's own object
// is not mutated for whatever else imports it.
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
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { overriding } = await import("~/lib/overriding");
  return overriding(actual, {
    useNavigate: () => navigate,
  });
});

const orgs = [
  { orgId: "o1", name: "Acme", role: "owner", active: true },
  { orgId: "o2", name: "Other Co", role: "member", active: false },
];

const invitesToMe = [
  { id: "i9", orgName: "Third Co", role: "member", expiresAt: "2026-09-01T00:00:00Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
  navigate.mockResolvedValue(undefined);
  createOrg.mockResolvedValue(authOk({ id: "o3", name: "Second Co" }));
  setActive.mockResolvedValue(authOk({ id: "o2", name: "Other Co" }));
  acceptInvitation.mockResolvedValue(authOk({ invitation: { id: "i9" }, member: { id: "m9" } }));
  rejectInvitation.mockResolvedValue(authOk({ invitation: { id: "i9" } }));
});

describe("OrgList", () => {
  // Which org is active is a property of the SESSION, and the page says so —
  // people with the app open twice have reported it as a bug.
  it("marks the active org rather than offering to switch to it", () => {
    renderInApp(<OrgList orgs={orgs} invites={[]} />);

    expect(screen.getByText("active")).toBeInTheDocument();
    // One button, for the one org that is not already active.
    expect(screen.getAllByRole("button", { name: "Switch to it" })).toHaveLength(1);
  });

  it("switches to another org", async () => {
    const user = userEvent.setup();
    renderInApp(<OrgList orgs={orgs} invites={[]} />);

    await user.click(screen.getByRole("button", { name: "Switch to it" }));

    expect(setActive).toHaveBeenCalledWith({ organizationId: "o2" });
  });

  // The create screen only appears to somebody who belongs to nowhere, so
  // without this an account gets exactly one organization, forever. It used to
  // be at the bottom of the page about a DIFFERENT org (#81).
  it("lets a reader start another organization", async () => {
    const user = userEvent.setup();
    renderInApp(<OrgList orgs={orgs} invites={[]} />);

    await user.type(screen.getByLabelText("Name"), "Second Co");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    expect(createOrg).toHaveBeenCalledWith({ name: "Second Co", slug: "second-co" });
  });

  // No cap, on any plan: a plan is bought per org, so limiting how many you may
  // make would limit how much you may buy. And not owner-only either — a member
  // of somebody else's org may still start their own.
  it("offers it to somebody who owns nothing", () => {
    renderInApp(
      <OrgList
        orgs={[{ orgId: "o2", name: "Other Co", role: "member", active: true }]}
        invites={[]}
      />,
    );
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  // Joining lands the caller in a different org, so the answer to every other
  // question on every other page changed too.
  it("treats joining another org as more than an org change", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<OrgList orgs={orgs} invites={invitesToMe} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const remove = vi.spyOn(queryClient, "removeQueries");

    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(acceptInvitation).toHaveBeenCalledWith({ invitationId: "i9" });
    // The whole cache, not one key: a different org answers everything from
    // here on, so every cached answer is about the old one.
    expect(invalidate).toHaveBeenCalledWith();
    // And what is not mounted is dropped, or the next loader would render it.
    expect(remove).toHaveBeenCalledWith({ type: "inactive" });
  });

  it("reports why an invitation could not be accepted", async () => {
    acceptInvitation.mockResolvedValue(authError(400, "invitation expired"));
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<OrgList orgs={orgs} invites={invitesToMe} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Join" }));

    expect(toastError).toHaveBeenCalledWith("invitation expired");
    // Still in the same org, so nothing may be thrown away.
    expect(invalidate).not.toHaveBeenCalled();
  });

  // An empty card headed "Invitations" invites a reader to wonder what is
  // missing. There is nothing to say, so nothing is said.
  it("draws no invitations card when there are none", () => {
    renderInApp(<OrgList orgs={orgs} invites={[]} />);
    expect(screen.queryByText("Invitations")).not.toBeInTheDocument();
  });
});

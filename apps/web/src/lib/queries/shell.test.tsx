import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { type Shell, useShell } from "./shell";

const listClusters = vi.hoisted(() => vi.fn());
const getOrg = vi.hoisted(() => vi.fn());
const listOrgs = vi.hoisted(() => vi.fn());
const listMyInvites = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({
  api: () => ({ listClusters, getOrg, listOrgs, listMyInvites }),
}));

const CLUSTER = {
  id: "c1",
  name: "Production",
  connectionMode: "HOSTED_DIRECT",
  engine: "MONGODB",
  readOnly: true,
  provisionedUsername: null,
  lastCollectedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const ORG = { id: "o1", name: "Acme", plan: {}, members: [], pendingInvites: [] };
const ORGS = [{ orgId: "o1", name: "Acme", role: "owner", active: true }];

// The three states the layout draws from, printed so a test can read one off the
// DOM. useShell is a hook over four queries, so it needs a component to live in.
function Probe() {
  const shell: Shell = useShell();
  if (shell.authed) return <p>authed:{shell.clusters.length}</p>;
  return <p>{shell.apiDown ? "api-down" : "signed-out"}</p>;
}

beforeEach(() => {
  listClusters.mockResolvedValue([CLUSTER]);
  getOrg.mockResolvedValue(ORG);
  listOrgs.mockResolvedValue(ORGS);
  listMyInvites.mockResolvedValue([]);
});

describe("useShell", () => {
  it("is signed in once the reads land", async () => {
    renderInApp(<Probe />);
    expect(await screen.findByText("authed:1")).toBeInTheDocument();
  });

  // The derivation replaced a try/catch inside one composite query. A 401 on any
  // of the three is the api saying nobody is asking — they go to the same api with
  // the same cookie, so one is enough and it must not read as "api unreachable",
  // which would hide the sign-in form from someone who needs it.
  it.each(["clusters", "org", "orgs", "invites"] as const)(
    "reads a 401 on %s as signed out",
    async (which) => {
      const unauthorized = apiError(401, "unauthorized");
      if (which === "clusters") listClusters.mockRejectedValue(unauthorized);
      if (which === "org") getOrg.mockRejectedValue(unauthorized);
      if (which === "orgs") listOrgs.mockRejectedValue(unauthorized);
      if (which === "invites") listMyInvites.mockRejectedValue(unauthorized);

      renderInApp(<Probe />);

      expect(await screen.findByText("signed-out")).toBeInTheDocument();
    },
  );

  // Anything that is not a 401 is "we could not ask", which gets the retry card
  // rather than a sign-in form the reader has already filled in once.
  it("reads any other failure as the api being unreachable", async () => {
    getOrg.mockRejectedValue(new Error("offline"));
    renderInApp(<Probe />);
    expect(await screen.findByText("api-down")).toBeInTheDocument();
  });

  // A reader who belongs to no organization is signed IN. getOrg answers null
  // for them rather than failing, because a create-org screen is not an error
  // page — and the layout can only draw it if the gate lets them through.
  it("calls someone with no organization signed in", async () => {
    getOrg.mockResolvedValue(null);
    listClusters.mockResolvedValue([]);
    listOrgs.mockResolvedValue([]);

    renderInApp(<Probe />);

    expect(await screen.findByText("authed:0")).toBeInTheDocument();
  });

  // A 401 outranks a transport failure: signed out is the actionable answer, and
  // the retry card would send someone to press a button that cannot help.
  it("prefers signed out when one read 401s and another simply failed", async () => {
    listClusters.mockRejectedValue(apiError(401, "unauthorized"));
    listOrgs.mockRejectedValue(new Error("offline"));

    renderInApp(<Probe />);

    expect(await screen.findByText("signed-out")).toBeInTheDocument();
  });

  // The reads are independent now, which is the point of splitting them — but the
  // auth gate is deliberately not: it needs the cluster list, the org list and the
  // invitations before it will call someone signed in, or the layout would draw a
  // cluster bar above an org switcher that is still empty.
  it("waits for the others rather than deciding on the first", async () => {
    let releaseOrgs = (): void => {};
    listOrgs.mockReturnValue(
      new Promise((resolve) => {
        releaseOrgs = () => resolve(ORGS);
      }),
    );

    renderInApp(<Probe />);

    expect(await screen.findByText("api-down")).toBeInTheDocument();
    releaseOrgs();
    await waitFor(() => expect(screen.getByText("authed:1")).toBeInTheDocument());
  });
});

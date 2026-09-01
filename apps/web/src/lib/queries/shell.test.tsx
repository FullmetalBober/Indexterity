import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { type Shell, useShell } from "./shell";

const listClusters = vi.hoisted(() => vi.fn());
const getOrg = vi.hoisted(() => vi.fn());
const listOrgs = vi.hoisted(() => vi.fn());
const listMyInvites = vi.hoisted(() => vi.fn());

// The real client with these calls replaced, through a forwarding Proxy: the
// oRPC client is itself a Proxy over fetch, so spreading it yields `{}` and a
// call this test never set up would answer `undefined` instead of failing.
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return {
    ...actual,
    api: () => overriding(actual.api(), { listClusters, getOrg, listOrgs, listMyInvites }),
  };
});

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

// The four states the layout draws from, printed so a test can read one off the
// DOM. useShell is a hook over four queries, so it needs a component to live in.
// The status rides along on "down" — "none" for a request that got no response
// at all, a number for one the api actually answered.
function Probe() {
  const shell: Shell = useShell();
  if (shell.authed) return <p>authed:{shell.clusters.length}</p>;
  if (shell.state === "loading") return <p>loading</p>;
  if (shell.state === "signed-out") return <p>signed-out</p>;
  return <p>down:{shell.failure.status ?? "none"}</p>;
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
  // rather than a sign-in form the reader has already filled in once. A plain
  // Error — nothing the api answered with, a dropped connection — carries no
  // status, which is the layout's cue to say "unreachable" rather than
  // guessing at a cause the failure never stated.
  it("reads a connection failure as unreachable, with no status", async () => {
    getOrg.mockRejectedValue(new Error("offline"));
    renderInApp(<Probe />);
    expect(await screen.findByText("down:none")).toBeInTheDocument();
  });

  // The api WAS reached here — a 500 is its own answer, not silence — so the
  // layout has a status to show instead of calling this "unreachable" too.
  it("carries a 500's status through, rather than flattening it to unreachable", async () => {
    getOrg.mockRejectedValue(apiError(500, "internal error"));
    renderInApp(<Probe />);
    expect(await screen.findByText("down:500")).toBeInTheDocument();
  });

  // 429 is the caller going too fast, not the api being down — a status the
  // layout reads differently again (Retry, but say to wait first).
  it("carries a 429 through the same way", async () => {
    listClusters.mockRejectedValue(apiError(429, "rate limited"));
    renderInApp(<Probe />);
    expect(await screen.findByText("down:429")).toBeInTheDocument();
  });

  // When more than one of the four fails and their shapes differ, the one
  // that actually answered wins — it says more than "nothing came back".
  it("prefers a status over no status when both are present", async () => {
    getOrg.mockRejectedValue(new Error("offline"));
    listOrgs.mockRejectedValue(apiError(503, "database unreachable"));
    renderInApp(<Probe />);
    expect(await screen.findByText("down:503")).toBeInTheDocument();
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
  //
  // "loading", not "down": this is the exact shape a cold SSR render of a
  // deep-linked route sees before the loader's reads have settled — nothing has
  // failed, nothing has answered yet either. It used to read as "down" (nothing
  // cached was folded into the same bucket as an actual failure), which is what
  // showed "The API is unreachable right now" on a plain page load that just
  // had not finished loading.
  it("is loading, not down, while the others are still in flight", async () => {
    let releaseOrgs = (): void => {};
    listOrgs.mockReturnValue(
      new Promise((resolve) => {
        releaseOrgs = () => resolve(ORGS);
      }),
    );

    renderInApp(<Probe />);

    expect(await screen.findByText("loading")).toBeInTheDocument();
    releaseOrgs();
    await waitFor(() => expect(screen.getByText("authed:1")).toBeInTheDocument());
  });
});

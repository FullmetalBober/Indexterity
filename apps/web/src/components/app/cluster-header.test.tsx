import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ClusterHeader, tlsConcessions } from "./cluster-header";

const NOW = new Date("2026-08-02T12:00:00Z");

// Every certificate check still in place — the shape of a cluster nobody had to
// make a concession for, which is all of them until somebody ticks a box.
const NO_OVERRIDES = {
  allowInvalidCertificates: false,
  allowInvalidHostnames: false,
  insecure: false,
};

const cluster = {
  name: "Production",
  readOnly: true,
  provisionedUsername: null,
  lastCollectedAt: NOW.toISOString(),
  tlsOverrides: NO_OVERRIDES,
  blocked: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClusterHeader", () => {
  it("shows read-only and live as visually different states", () => {
    const { rerender } = renderInApp(<ClusterHeader cluster={cluster} />);
    expect(screen.getByText("read-only")).toBeInTheDocument();

    rerender(<ClusterHeader cluster={{ ...cluster, readOnly: false }} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  // Stale figures reading as current is the failure this badge exists to stop.
  it("warns once collection has been silent for two days", async () => {
    const twoDays = new Date(NOW.getTime() - 50 * 3_600_000).toISOString();
    renderInApp(<ClusterHeader cluster={{ ...cluster, lastCollectedAt: twoDays }} />);
    expect(await screen.findByText(/last collected 2 days ago/)).toBeInTheDocument();
  });

  it("says nothing while collection is keeping up", () => {
    const recent = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    renderInApp(<ClusterHeader cluster={{ ...cluster, lastCollectedAt: recent }} />);
    expect(screen.queryByText(/last collected/)).not.toBeInTheDocument();
  });

  it("distinguishes never collected from stale", async () => {
    renderInApp(<ClusterHeader cluster={{ ...cluster, lastCollectedAt: null }} />);
    expect(await screen.findByText(/never collected/)).toBeInTheDocument();
  });

  it("names the scoped user it runs as, when there is one", () => {
    const { rerender } = renderInApp(<ClusterHeader cluster={cluster} />);
    expect(screen.queryByText("idx_abc")).not.toBeInTheDocument();

    rerender(<ClusterHeader cluster={{ ...cluster, provisionedUsername: "idx_abc" }} />);
    expect(screen.getByText("idx_abc")).toBeInTheDocument();
  });

  // The heading answers which cluster and whether to believe it, and nothing
  // else. Every control that CHANGES the cluster moved to its settings page —
  // Disconnect used to be two buttons along from a cluster selector, both one
  // click (#81).
  it("carries no control that changes the cluster", () => {
    renderInApp(<ClusterHeader cluster={cluster} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

// The concession is chosen once, at a moment when the only goal is getting the
// connection to work, and it is permanent until somebody changes it. Storing it
// and never showing it would have made it unreviewable — so it sits beside the
// read-only badge, where the reader already looks to decide whether to believe
// what is underneath.
describe("tlsConcessions", () => {
  it("says nothing about a cluster that gave up nothing", () => {
    expect(tlsConcessions(NO_OVERRIDES)).toEqual([]);
  });

  it("names each check that is off", () => {
    expect(tlsConcessions({ ...NO_OVERRIDES, allowInvalidCertificates: true })).toEqual([
      "certificate not verified",
    ]);
    expect(
      tlsConcessions({
        ...NO_OVERRIDES,
        allowInvalidCertificates: true,
        allowInvalidHostnames: true,
      }),
    ).toEqual(["certificate not verified", "hostname not checked"]);
  });

  // tlsInsecure is a superset of the other two. Listing them beside it would
  // read as three separate problems where there is one broader one.
  it("reports the broadest one alone", () => {
    expect(
      tlsConcessions({
        allowInvalidCertificates: true,
        allowInvalidHostnames: true,
        insecure: true,
      }),
    ).toEqual(["no certificate checks at all"]);
  });
});

describe("ClusterHeader certificate concessions", () => {
  it("draws no badge when every check is in place", () => {
    renderInApp(<ClusterHeader cluster={cluster} />);
    expect(screen.queryByText(/certificate/)).not.toBeInTheDocument();
  });

  it("shows what was given up, beside the read-only badge", () => {
    renderInApp(
      <ClusterHeader
        cluster={{
          ...cluster,
          tlsOverrides: { ...NO_OVERRIDES, allowInvalidCertificates: true },
        }}
      />,
    );
    expect(screen.getByText(/certificate not verified/)).toBeInTheDocument();
  });

  // The gap this badge closes. "last collected 7 days ago" has innocent causes —
  // a paused schedule, a cluster with nothing left to collect — so on its own it
  // reads as "nothing is obviously wrong".
  it("says why collection stopped, not just that figures are old", () => {
    renderInApp(
      <ClusterHeader
        cluster={{
          ...cluster,
          lastCollectedAt: new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString(),
          blocked: {
            reason: "UNREACHABLE",
            since: new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString(),
            detail: "connect ECONNREFUSED 10.0.0.4:27017",
            task: null,
          },
        }}
      />,
    );

    expect(screen.getByText("⚠ cannot be reached")).toBeInTheDocument();
    // Both, and in that order: the reason explains the staleness beside it.
    expect(screen.getByText("⚠ last collected 7 days ago")).toBeInTheDocument();
  });

  it("renders a reason it has no wording for rather than nothing", () => {
    // The column is text so that adding a reason is a constant rather than a
    // migration, which is only safe if an older dashboard degrades.
    renderInApp(
      <ClusterHeader
        cluster={{
          ...cluster,
          blocked: { reason: "QUOTA_EXHAUSTED", since: NOW.toISOString(), detail: "", task: null },
        }}
      />,
    );

    expect(screen.getByText("⚠ collection stopped")).toBeInTheDocument();
  });
});

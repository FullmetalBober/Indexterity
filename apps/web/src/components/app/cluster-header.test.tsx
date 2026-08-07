import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ClusterHeader } from "./cluster-header";

const NOW = new Date("2026-08-02T12:00:00Z");

const cluster = {
  name: "Production",
  readOnly: true,
  provisionedUsername: null,
  lastCollectedAt: NOW.toISOString(),
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

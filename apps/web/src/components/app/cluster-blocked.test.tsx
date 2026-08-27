import { screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { blockedFor, ClusterBlockedBanner } from "./cluster-blocked";

// A Link outside a router throws on `isServer` rather than rendering, and what
// this file is about is the wording — so the anchor stands in for it, the way
// verification-outcome.test.tsx does.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const NOW = new Date("2026-08-27T12:00:00.000Z");
const CLUSTER = "11111111-1111-4111-8111-111111111111";

function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("blockedFor", () => {
  // How long it has been going on is what decides whether somebody acts, so the
  // wording is coarse on purpose: nobody needs "6 days 4 hours".
  it("reads as a duration a person would say", () => {
    expect(blockedFor(ago(0.5))).toBe("for 30 minutes");
    expect(blockedFor(ago(1))).toBe("for an hour");
    expect(blockedFor(ago(10))).toBe("for 10 hours");
    expect(blockedFor(ago(24 * 7))).toBe("for 7 days");
  });

  it("does not read a clock skew as a negative age", () => {
    // A worker a second ahead of the browser must not produce "for -1 minutes".
    expect(blockedFor(new Date(NOW.getTime() + 5_000).toISOString())).toBe("just now");
  });
});

describe("ClusterBlockedBanner", () => {
  it("says what happened, for how long, in whose words, and what to do", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{
          reason: "UNREACHABLE",
          since: ago(24 * 7),
          detail: "connect ECONNREFUSED 10.0.0.4:27017",
        }}
      />,
    );

    expect(screen.getByText(/cannot reach this cluster/)).toBeInTheDocument();
    expect(screen.getByText(/for 7 days/)).toBeInTheDocument();
    // The driver's own message, which usually says more than any wording of ours.
    expect(screen.getByText("connect ECONNREFUSED 10.0.0.4:27017")).toBeInTheDocument();
    expect(screen.getByText(/paused or down/)).toBeInTheDocument();
  });

  it("blames the gateway rather than the database when the tunnel is down", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "TUNNEL_DOWN", since: ago(3), detail: "" }}
      />,
    );

    // The distinction the whole tunnel design keeps: the database may be
    // answering perfectly and we never dialled it.
    expect(screen.getByText(/may be answering perfectly/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to VPN tunnels" })).toBeInTheDocument();
  });

  it("words a refusal as a refusal, not as a failure to reach", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "INSECURE", since: ago(3), detail: "" }}
      />,
    );

    expect(screen.getByText(/declining to connect/)).toBeInTheDocument();
    expect(screen.getByText(/this is a refusal, not a failure to reach it/)).toBeInTheDocument();
  });

  it("sends an unreadable-credentials cluster to the operator, not the owner", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "CREDENTIALS", since: ago(3), detail: "" }}
      />,
    );

    expect(screen.getByText(/needs whoever runs this Indexterity/)).toBeInTheDocument();
  });

  it("renders a reason it has no wording for, and says so", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "QUOTA_EXHAUSTED", since: ago(3), detail: "" }}
      />,
    );

    expect(screen.getByText(/Collection against this cluster has stopped/)).toBeInTheDocument();
    // Named rather than swallowed: a newer worker's reason is still a fact the
    // reader can take to somebody.
    expect(screen.getByText(/"QUOTA_EXHAUSTED"/)).toBeInTheDocument();
  });

  it("omits the detail line when there is nothing in it", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "UNREACHABLE", since: ago(3), detail: "" }}
      />,
    );

    // An empty monospaced paragraph is a gap the layout reserved for nothing.
    expect(screen.queryByText("", { selector: "p.font-mono" })).not.toBeInTheDocument();
  });
});

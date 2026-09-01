import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { blockedFor, ClusterBlockedBanner } from "./cluster-blocked";

// A Link outside a router throws on `isServer` rather than rendering, and what
// this file is about is the wording — so the anchor stands in for it, the way
// verification-outcome.test.tsx does.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { overriding } = await import("~/lib/overriding");
  return overriding(actual, {
    // `props` is left to the contextual type — TanStack's Link is a GENERIC
    // component, and a double annotating its own narrower props is not the
    // component it stands in for. Which is also why the render-prop form is
    // honoured below: a Link's children may be a function, and this one used to
    // drop it on the floor.
    Link: (props) => (
      <a href={String(props.to)}>
        {typeof props.children === "function"
          ? props.children({ isActive: false, isTransitioning: false })
          : props.children}
      </a>
    ),
  });
});

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
          task: null,
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
        block={{ reason: "TUNNEL_DOWN", since: ago(3), detail: "", task: null }}
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
        block={{ reason: "INSECURE", since: ago(3), detail: "", task: null }}
      />,
    );

    expect(screen.getByText(/declining to connect/)).toBeInTheDocument();
    expect(screen.getByText(/this is a refusal, not a failure to reach it/)).toBeInTheDocument();
  });

  it("sends an unreadable-credentials cluster to the operator, not the owner", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "CREDENTIALS", since: ago(3), detail: "", task: null }}
      />,
    );

    expect(screen.getByText(/needs whoever runs this Indexterity/)).toBeInTheDocument();
  });

  it("renders a reason it has no wording for, and says so", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "QUOTA_EXHAUSTED", since: ago(3), detail: "", task: null }}
      />,
    );

    expect(screen.getByText(/Collection against this cluster has stopped/)).toBeInTheDocument();
    // Named rather than swallowed: a newer worker's reason is still a fact the
    // reader can take to somebody.
    expect(screen.getByText(/"QUOTA_EXHAUSTED"/)).toBeInTheDocument();
  });

  // #408: ERROR is the reason a pass lands on when the dial WORKED and the pass
  // itself did not, so it is the one where naming collection is wrong exactly
  // when it matters. In production a failing `suggest` was reported as
  // collection failing and sent the first hour of diagnosis at the wrong pass.
  it("names the pass that failed rather than assuming collection", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "ERROR", since: ago(3), detail: "socket hang up", task: "suggest" }}
      />,
    );

    expect(
      screen.getByText(/Working out recommendations for this cluster is failing/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Collection against this cluster/)).not.toBeInTheDocument();
    // And it must not claim collection stopped, because it did not.
    expect(screen.queryByText(/Nothing has been collected since then/)).not.toBeInTheDocument();
  });

  it("does say nothing has been collected when collect is the pass that failed", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "ERROR", since: ago(3), detail: "socket hang up", task: "collect" }}
      />,
    );

    expect(screen.getByText(/Collecting from this cluster is failing/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been collected since then/)).toBeInTheDocument();
  });

  // Text, not an enum, so a pass written by a newer worker than this dashboard
  // has to render as itself — the same rule the unknown REASON follows.
  it("quotes a pass it has no wording for", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "ERROR", since: ago(3), detail: "boom", task: "reticulate" }}
      />,
    );

    expect(screen.getByText(/The reticulate step is failing/)).toBeInTheDocument();
  });

  // A block written before the column existed. It is still a perfectly good
  // block and must still render; what it loses is the ability to name the pass.
  it("falls back to general wording when the block predates the pass column", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "ERROR", since: ago(3), detail: "boom", task: null }}
      />,
    );

    expect(screen.getByText(/A step in the pipeline is failing/)).toBeInTheDocument();
  });

  // #407: a pass abandoned for running past its budget. Deliberately not ERROR —
  // nothing went wrong that a message can describe, and the answer is a setting
  // rather than a bug report.
  it("says a step did not fit rather than that it failed", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{
          reason: "TIMED_OUT",
          since: ago(3),
          detail: "the suggest pass ran past its 300s budget and was abandoned",
          task: "suggest",
        }}
      />,
    );

    expect(screen.getByText(/takes longer than Indexterity will wait/)).toBeInTheDocument();
    // The reassurance that matters most: a build is never cut off this way.
    expect(screen.getByText(/Applying a change is never cut off this way/)).toBeInTheDocument();
    expect(screen.queryByText(/does not have a name for/)).not.toBeInTheDocument();
  });

  it("omits the detail line when there is nothing in it", () => {
    renderInApp(
      <ClusterBlockedBanner
        clusterId={CLUSTER}
        block={{ reason: "UNREACHABLE", since: ago(3), detail: "", task: null }}
      />,
    );

    // An empty monospaced paragraph is a gap the layout reserved for nothing.
    expect(screen.queryByText("", { selector: "p.font-mono" })).not.toBeInTheDocument();
  });
});

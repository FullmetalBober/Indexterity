import type { ClusterNodes } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodesPanel } from "./nodes-panel";

const FULL_SET: ClusterNodes = {
  clusterId: "c1",
  collectedAt: "2026-08-07T12:00:00.000Z",
  nodes: [
    { host: "a:27017", role: "primary", state: "answered" },
    { host: "b:27017", role: "secondary", state: "answered" },
    { host: "c:27017", role: "secondary", state: "answered" },
  ],
};

describe("NodesPanel", () => {
  // "4 of 5 members answered" is the sentence the panel exists to say (#100) —
  // partial coverage was invisible before it.
  it("counts the members that answered against the members that exist", () => {
    render(
      <NodesPanel
        roster={{
          ...FULL_SET,
          nodes: [
            ...FULL_SET.nodes,
            { host: "d:27017", role: "unknown", state: "unreachable" },
            { host: "e:27017", role: "unknown", state: "refused" },
          ],
        }}
        loading={false}
      />,
    );
    expect(screen.getByText("3 of 5 members answered")).toBeInTheDocument();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    // The net guard's refusal is a policy fact, and the words say so.
    expect(screen.getByText("refused by policy")).toBeInTheDocument();
  });

  it("lists every member with its host and role", () => {
    render(<NodesPanel roster={FULL_SET} loading={false} />);
    expect(screen.getByText("3 of 3 members answered")).toBeInTheDocument();
    expect(screen.getByText("a:27017")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(screen.getAllByText("secondary")).toHaveLength(2);
  });

  // A roster of one is not a replica set, so it must not pretend to be a count.
  it("says what a single node is instead of counting it", () => {
    render(
      <NodesPanel
        roster={{
          ...FULL_SET,
          nodes: [{ host: "solo:27017", role: "standalone", state: "answered" }],
        }}
        loading={false}
      />,
    );
    expect(screen.getByText("One node (standalone)")).toBeInTheDocument();
  });

  // Nothing collected yet and nothing matching are different answers — the
  // empty state says what will appear and when.
  it("explains the empty state rather than drawing an empty list", () => {
    render(
      <NodesPanel roster={{ clusterId: "c1", collectedAt: null, nodes: [] }} loading={false} />,
    );
    expect(screen.getByText("No roster yet")).toBeInTheDocument();
    expect(screen.getByText(/first collect records/)).toBeInTheDocument();
  });

  it("draws nothing while the first read is still out", () => {
    const { container } = render(<NodesPanel roster={null} loading={true} />);
    expect(container).toBeEmptyDOMElement();
  });
});

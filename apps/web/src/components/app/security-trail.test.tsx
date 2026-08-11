import type { SecurityEvent, SecurityTrail } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SecurityTrailTable } from "./security-trail";

function event(over: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    event: "SIGN_IN",
    actorUserId: "u1",
    actorEmail: "ana@example.com",
    target: null,
    clusterId: null,
    metadata: null,
    ipAddress: "203.0.113.7",
    userAgent: "Firefox",
    createdAt: "2026-08-11T09:00:00.000Z",
    ...over,
  };
}

function trail(over: Partial<SecurityTrail> = {}): SecurityTrail {
  return { events: [event()], total: 1, nextCreatedAt: null, nextId: null, ...over };
}

const NOOP = {
  onFilter: () => {},
  onOlder: () => {},
  onNewest: () => {},
  members: [],
  filter: {},
  paged: false,
};

describe("SecurityTrailTable", () => {
  it("draws a row per act, with who did it and where from", () => {
    render(<SecurityTrailTable {...NOOP} trail={trail()} loading={false} />);
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
  });

  // The whole reason this screen needed thinking about: a failed sign-in must
  // not read as something the account holder did.
  it("shows a failed sign-in with no actor and the address as an attempt", () => {
    render(
      <SecurityTrailTable
        {...NOOP}
        trail={trail({
          events: [
            event({
              id: "22222222-2222-4222-8222-222222222222",
              event: "SIGN_IN_FAILED",
              actorUserId: null,
              actorEmail: null,
              target: "ana@example.com",
            }),
          ],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("Failed sign-in")).toBeInTheDocument();
    expect(screen.getByText("attempted as ana@example.com")).toBeInTheDocument();
    // And not as an actor: the address appears once, in the subject column.
    expect(screen.queryAllByText("ana@example.com")).toHaveLength(0);
  });

  // The api reads a forwarded header only where a proxy is declared, so an
  // install without one records nothing rather than the proxy's own address.
  it("says an address was not recorded rather than leaving the cell blank", () => {
    render(
      <SecurityTrailTable
        {...NOOP}
        trail={trail({ events: [event({ ipAddress: null })] })}
        loading={false}
      />,
    );
    expect(screen.getByText("not recorded")).toBeInTheDocument();
  });

  it("says how many acts match when it is showing one page of them", () => {
    render(<SecurityTrailTable {...NOOP} trail={trail({ total: 4312 })} loading={false} />);
    expect(screen.getByText(/Showing 1 of 4,312 acts/)).toBeInTheDocument();
  });

  it("claims no truncation when it is showing all of them", () => {
    render(<SecurityTrailTable {...NOOP} trail={trail({ total: 1 })} loading={false} />);
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  // Offered only when the api said there IS a next page. Paging into an empty
  // one to find the end is how a reader concludes the trail stops early.
  it("offers older only when another page exists", () => {
    const { rerender } = render(<SecurityTrailTable {...NOOP} trail={trail()} loading={false} />);
    expect(screen.queryByRole("button", { name: "Older" })).not.toBeInTheDocument();
    rerender(
      <SecurityTrailTable
        {...NOOP}
        trail={trail({ nextCreatedAt: "2026-08-11T08:00:00.000Z", nextId: event().id })}
        loading={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Older" })).toBeInTheDocument();
  });

  it("hands the cursor back when older is clicked", async () => {
    const onOlder = vi.fn();
    const user = userEvent.setup();
    render(
      <SecurityTrailTable
        {...NOOP}
        onOlder={onOlder}
        trail={trail({ nextCreatedAt: "2026-08-11T08:00:00.000Z", nextId: event().id })}
        loading={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Older" }));
    expect(onOlder).toHaveBeenCalledOnce();
  });

  it("offers a way back to the newest rows only once paged away", () => {
    const { rerender } = render(<SecurityTrailTable {...NOOP} trail={trail()} loading={false} />);
    expect(screen.queryByRole("button", { name: "Newest" })).not.toBeInTheDocument();
    rerender(<SecurityTrailTable {...NOOP} paged={true} trail={trail()} loading={false} />);
    expect(screen.getByRole("button", { name: "Newest" })).toBeInTheDocument();
  });

  it("sends a chosen kind to the caller rather than filtering what arrived", async () => {
    const onFilter = vi.fn();
    const user = userEvent.setup();
    render(<SecurityTrailTable {...NOOP} onFilter={onFilter} trail={trail()} loading={false} />);
    await user.click(screen.getByLabelText("Filter by kind"));
    await user.click(await screen.findByRole("option", { name: "Failed sign-in" }));
    expect(onFilter).toHaveBeenCalledWith({ event: "SIGN_IN_FAILED" });
  });

  // An empty page under a filter is not an empty trail, and saying so is what
  // stops a reader concluding nothing has ever happened here.
  it("tells an empty filter result apart from an empty trail", () => {
    const { rerender } = render(
      <SecurityTrailTable {...NOOP} trail={trail({ events: [], total: 0 })} loading={false} />,
    );
    expect(screen.getByText(/Nothing yet means nothing has/)).toBeInTheDocument();
    rerender(
      <SecurityTrailTable
        {...NOOP}
        filter={{ event: "SIGN_IN_FAILED" }}
        trail={trail({ events: [], total: 0 })}
        loading={false}
      />,
    );
    expect(screen.getByText(/The trail itself is not empty/)).toBeInTheDocument();
  });

  // Nothing is claimed about the organization before the read has answered.
  it("stays quiet while the first fetch is out", () => {
    render(<SecurityTrailTable {...NOOP} trail={trail({ events: [], total: 0 })} loading={true} />);
    expect(screen.queryByText(/Nothing yet means nothing has/)).not.toBeInTheDocument();
  });
});

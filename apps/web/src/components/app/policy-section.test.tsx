import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicySection } from "./policy-section";

const savePolicy = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("~/lib/app-server", () => ({ savePolicy }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const policy = {
  clusterId: "c1",
  workloadAnalysis: false,
  instantCreate: false,
  observeWindowDays: 30,
  autoApplyScore: null,
  changeWindowStartHour: null,
  changeWindowEndHour: null,
  inferredWindowReason: null,
};

// The last argument savePolicy was called with, unwrapped from the server-fn
// { data } envelope.
function savedPayload(): Record<string, unknown> {
  const call: unknown = savePolicy.mock.calls.at(-1)?.[0];
  if (typeof call !== "object" || call === null || !("data" in call)) {
    throw new Error("savePolicy was not called with a data envelope");
  }
  const { data } = call;
  if (typeof data !== "object" || data === null) throw new Error("no data");
  return { ...data };
}

beforeEach(() => {
  savePolicy.mockResolvedValue({ ok: true });
});

describe("PolicySection", () => {
  it("saves the toggles the reader actually set", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<PolicySection policy={policy} onSaved={onSaved} />);

    await user.click(screen.getByLabelText("Workload analysis"));
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(savedPayload()).toMatchObject({
      clusterId: "c1",
      workloadAnalysis: true,
      instantCreate: false,
      observeWindowDays: 30,
    });
    expect(toastSuccess).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  // A window with only one end is not a window. Persisting half of it would
  // leave the engine with a start and no stop, or the reverse.
  it("drops a half-set change window rather than persisting one end", async () => {
    const user = userEvent.setup();
    render(<PolicySection policy={policy} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText("Change window (UTC hours)"), "2");
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(savedPayload()).toMatchObject({
      changeWindowStartHour: null,
      changeWindowEndHour: null,
    });
  });

  it("keeps a window once both ends are set", async () => {
    const user = userEvent.setup();
    render(<PolicySection policy={policy} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText("Change window (UTC hours)"), "2");
    await user.type(screen.getByLabelText("Change window end hour"), "6");
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(savedPayload()).toMatchObject({
      changeWindowStartHour: 2,
      changeWindowEndHour: 6,
    });
  });

  // Empty and 0 are opposites here — one approves nothing, the other approves
  // everything — so the field must never collapse them.
  it("distinguishes an empty auto-approve score from zero", async () => {
    const user = userEvent.setup();
    render(<PolicySection policy={policy} onSaved={vi.fn()} />);
    const score = screen.getByLabelText("Auto-approve score ≥");

    expect(screen.getByText(/nothing is approved without you/)).toBeInTheDocument();

    await user.type(score, "0");
    expect(screen.getByText(/every recommendation is approved automatically/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(savedPayload()).toMatchObject({ autoApplyScore: 0 });
  });

  it("warns that very little qualifies above the recommended threshold", async () => {
    const user = userEvent.setup();
    render(<PolicySection policy={policy} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText("Auto-approve score ≥"), "90");
    expect(screen.getByText(/Above ~85 very little qualifies/)).toBeInTheDocument();
  });

  // Two different failures reach here now — not an owner, or the plan does not
  // include what was switched on — so the api's own reason has to come through.
  it("shows the api's reason when a save is refused, and does not claim success", async () => {
    savePolicy.mockResolvedValue({
      ok: false,
      message: "the FREE plan does not include workload analysis",
    });
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<PolicySection policy={policy} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(toastError).toHaveBeenCalledWith("the FREE plan does not include workload analysis");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  // A rejected promise must land in the same place as { ok: false }, or the
  // reader gets an unhandled rejection and no feedback at all.
  it("treats a thrown server function as a failed save", async () => {
    savePolicy.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(<PolicySection policy={policy} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(toastError).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("explains why there is no inferred window when the engine gave a reason", () => {
    render(
      <PolicySection
        policy={{ ...policy, inferredWindowReason: "traffic is flat across the day" }}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText("traffic is flat across the day")).toBeInTheDocument();
  });
});

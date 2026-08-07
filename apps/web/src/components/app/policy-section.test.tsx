import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, renderInApp } from "~/test-utils";
import { PolicySection } from "./policy-section";

const updatePolicy = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// The api client, which the mutation hook now calls directly. Mocking it rather
// than a server function means the hook's own error handling — which reason is
// safe to show — is under test instead of stubbed out with it.
vi.mock("~/lib/api", () => ({ api: () => ({ updatePolicy }) }));
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

// What was sent to the api on the last save.
function savedPayload(): Record<string, unknown> {
  const call: unknown = updatePolicy.mock.calls.at(-1)?.[0];
  if (typeof call !== "object" || call === null) throw new Error("updatePolicy was not called");
  return { ...call };
}

beforeEach(() => {
  updatePolicy.mockResolvedValue({ ...policy, maxCollectionSizeBytes: null });
});

describe("PolicySection", () => {
  it("saves the toggles the reader actually set", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<PolicySection policy={policy} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByLabelText("Workload analysis"));
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(savedPayload()).toMatchObject({
      clusterId: "c1",
      workloadAnalysis: true,
      instantCreate: false,
      observeWindowDays: 30,
    });
    expect(toastSuccess).toHaveBeenCalled();
    // Keyed on the cluster the form is showing, which is the cluster the
    // dashboard resolved — the same entry the form was filled from.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["policy", "c1"] });
  });

  // A window with only one end is not a window. It used to be silently completed
  // by nulling the hour that had just been typed, which is a number vanishing out
  // of a box for no stated reason; the form refuses the save and says which box
  // is the problem.
  it("refuses a half-set change window instead of quietly dropping it", async () => {
    const user = userEvent.setup();
    renderInApp(<PolicySection policy={policy} />);

    await user.type(screen.getByLabelText("Change window (UTC hours)"), "2");
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(await screen.findByText("Set both hours, or neither")).toBeInTheDocument();
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  // And filling the other end clears it, rather than leaving the reader stuck
  // behind an error about a state they have left.
  it("saves once the missing end is filled in", async () => {
    const user = userEvent.setup();
    renderInApp(<PolicySection policy={policy} />);

    await user.type(screen.getByLabelText("Change window (UTC hours)"), "2");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await user.type(screen.getByLabelText("Change window end hour"), "6");
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(savedPayload()).toMatchObject({ changeWindowStartHour: 2, changeWindowEndHour: 6 });
  });

  // The api's bounds, reported by the field rather than by a 400.
  it("names an out-of-range hour before the api has to", async () => {
    const user = userEvent.setup();
    renderInApp(<PolicySection policy={policy} />);

    await user.type(screen.getByLabelText("Change window (UTC hours)"), "99");
    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(await screen.findByText("0 to 23")).toBeInTheDocument();
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  it("keeps a window once both ends are set", async () => {
    const user = userEvent.setup();
    renderInApp(<PolicySection policy={policy} />);

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
    renderInApp(<PolicySection policy={policy} />);
    const score = screen.getByLabelText("Auto-approve score ≥");

    expect(screen.getByText(/nothing is approved without you/)).toBeInTheDocument();

    await user.type(score, "0");
    expect(screen.getByText(/every recommendation is approved automatically/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(savedPayload()).toMatchObject({ autoApplyScore: 0 });
  });

  it("warns that very little qualifies above the recommended threshold", async () => {
    const user = userEvent.setup();
    renderInApp(<PolicySection policy={policy} />);

    await user.type(screen.getByLabelText("Auto-approve score ≥"), "90");
    expect(screen.getByText(/Above ~85 very little qualifies/)).toBeInTheDocument();
  });

  // Two different failures reach here now — not an owner, or the plan does not
  // include what was switched on — so the api's own reason has to come through.
  it("shows the api's reason when a save is refused, and does not claim success", async () => {
    updatePolicy.mockRejectedValue(
      apiError(402, "the FREE plan does not include workload analysis"),
    );
    const user = userEvent.setup();
    const { queryClient } = renderInApp(<PolicySection policy={policy} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(toastError).toHaveBeenCalledWith("the FREE plan does not include workload analysis");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  // A call that never reached the api must land where a refusal does, or the
  // reader gets an unhandled rejection and no feedback at all. It carries no
  // status, so it gets the generic message rather than its own words.
  it("treats a call that never got an answer as a failed save", async () => {
    updatePolicy.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    renderInApp(<PolicySection policy={policy} />);

    await user.click(screen.getByRole("button", { name: "Save policy" }));

    expect(toastError).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("explains why there is no inferred window when the engine gave a reason", () => {
    renderInApp(
      <PolicySection
        policy={{ ...policy, inferredWindowReason: "traffic is flat across the day" }}
      />,
    );
    expect(screen.getByText("traffic is flat across the day")).toBeInTheDocument();
  });
});

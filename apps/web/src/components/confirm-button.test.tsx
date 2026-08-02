import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ConfirmButton } from "./confirm-button";

// Everything irreversible in the app goes through this. If it ever fired on the
// trigger click, or Cancel stopped working, a drop or a disconnect would happen
// on a stray click and nothing else in the UI would catch it.
describe("ConfirmButton", () => {
  function setup(onConfirm: () => void) {
    return renderInApp(
      <ConfirmButton
        trigger={<button type="button">Delete everything</button>}
        title="Are you sure?"
        description="This cannot be undone."
        confirmLabel="Yes, delete"
        onConfirm={onConfirm}
      />,
    );
  }

  it("does nothing until the reader confirms", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    setup(onConfirm);

    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    expect(await screen.findByText("Are you sure?")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels without acting", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    setup(onConfirm);

    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  });

  it("shows the consequences, not just the question", async () => {
    const user = userEvent.setup();
    setup(vi.fn());

    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    expect(await screen.findByText("This cannot be undone.")).toBeInTheDocument();
  });
});

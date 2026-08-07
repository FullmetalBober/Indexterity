import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppForm } from "./form";

// Asserting on a class rather than on behaviour, which no other test here does,
// because the behaviour is not observable in jsdom: it performs no layout and
// loads no stylesheet, so there is no selection to make and getComputedStyle
// resolves nothing for a Tailwind class. The class list is the closest
// stand-in, and what it guards is worth guarding — `select-none` is what the
// registry ships, so the next `shadcn add label` puts it straight back and
// every label in the app silently stops highlighting again.
function Harness() {
  const form = useAppForm({ defaultValues: { username: "", instantCreate: false } });
  return (
    <form>
      <form.AppField name="username">
        {(field) => <field.TextField label="Username" />}
      </form.AppField>
      <form.AppField name="instantCreate">
        {(field) => <field.CheckboxField label="Instant create" />}
      </form.AppField>
    </form>
  );
}

describe("field labels", () => {
  it("can be highlighted, except on the one row where the label is only a click target", () => {
    render(<Harness />);

    expect(screen.getByText("Username")).not.toHaveClass("select-none");
    expect(screen.getByText("Instant create")).toHaveClass("select-none");
  });
});

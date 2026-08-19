import type { PrivilegeCheck } from "@repo/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PrivilegeList } from "./privilege-list";

function privilege(over: Partial<PrivilegeCheck> = {}): PrivilegeCheck {
  return {
    key: "queryStore",
    label: "Query Store enabled",
    enables: "latency per table — off on appdb, reporting",
    tier: "WORKLOAD",
    granted: false,
    command: null,
    ...over,
  };
}

const TWO_STATEMENTS =
  "ALTER DATABASE [appdb] SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE, MAX_STORAGE_SIZE_MB = 1000);\n" +
  "ALTER DATABASE [reporting] SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE, MAX_STORAGE_SIZE_MB = 1000);";

describe("PrivilegeList", () => {
  // #246. The statements are ON the screen and in the clipboard, rather than
  // described in prose with an ellipsis the reader expands once per database.
  //
  // Read back through userEvent's own clipboard rather than a hand-rolled
  // navigator.clipboard stub: setup() installs its stub over whatever the test put
  // there, so a mock defined first is simply never called and the assertion fails
  // for a reason that has nothing to do with the component.
  it("shows the statements that would close a gap, and copies them", async () => {
    const user = userEvent.setup();
    render(<PrivilegeList privileges={[privilege({ command: TWO_STATEMENTS })]} />);

    expect(screen.getByText(/ALTER DATABASE \[appdb\]/)).toBeInTheDocument();
    // The count is in the label, so a reader knows the button takes both lines and
    // not only the one under the cursor.
    await user.click(screen.getByRole("button", { name: "Copy all 2" }));

    expect(await navigator.clipboard.readText()).toBe(TWO_STATEMENTS);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("says Copy, singular, for one statement", () => {
    render(
      <PrivilegeList
        privileges={[privilege({ command: "ALTER DATABASE [appdb] SET QUERY_STORE = ON;" })]}
      />,
    );

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  // A refused clipboard write is not worth an error: the statements are on the
  // screen either way, so "Copied" not appearing is the whole message.
  //
  // fireEvent rather than userEvent here, deliberately: this test needs the write to
  // REJECT, which means owning navigator.clipboard, which userEvent.setup() would
  // take back.
  it("stays quiet when the clipboard refuses", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PrivilegeList privileges={[privilege({ command: TWO_STATEMENTS })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy all 2" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(TWO_STATEMENTS));

    expect(screen.getByRole("button", { name: "Copy all 2" })).toBeInTheDocument();
  });

  // The failure that shipped: an api without this field sends no `command` key, so
  // the value is undefined, and `=== null` let it through into `command.split` —
  // "can't access property split, command is undefined", which the error boundary
  // draws as a blank "Something broke" over the whole page. Reachable in dev the
  // moment the web reloads and the api has not, and in prod for the length of a
  // rolling deploy.
  it("survives a response from an api that has never heard of the field", () => {
    const older = privilege();
    // Delete the key rather than setting undefined: this is the wire shape, and a
    // present-but-undefined property is not the same object an older api sends.
    delete (older as { command?: string | null }).command;

    render(<PrivilegeList privileges={[older]} />);

    expect(screen.getByText("Query Store enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("draws no command block for an empty command", () => {
    render(<PrivilegeList privileges={[privilege({ command: "" })]} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("draws no command block when there is nothing to run", () => {
    render(<PrivilegeList privileges={[privilege()]} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/off on appdb, reporting/)).toBeInTheDocument();
  });

  // The api only fills `command` for a check that is not granted, and the row only
  // draws `enables` for those — so a granted row is a label and a tick, as before.
  it("says nothing beyond the label for a granted check", () => {
    render(<PrivilegeList privileges={[privilege({ granted: true, command: null })]} />);

    expect(screen.getByText("Query Store enabled")).toBeInTheDocument();
    expect(screen.queryByText(/off on appdb/)).not.toBeInTheDocument();
  });
});

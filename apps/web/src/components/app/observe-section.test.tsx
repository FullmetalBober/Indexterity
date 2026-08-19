import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ObserveSection } from "./observe-section";

const setObservedDatabases = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({ api: () => ({ setObservedDatabases }) }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const cluster = { id: "c1", provisionedUsername: null };
const provisioned = { id: "c1", provisionedUsername: "idx_ab12cd" };

beforeEach(() => {
  vi.clearAllMocks();
  setObservedDatabases.mockResolvedValue({ id: "c1", observedDatabases: ["app"] });
});

describe("ObserveSection", () => {
  it("ticks every box for a cluster observing everything", () => {
    renderInApp(
      <ObserveSection
        cluster={cluster}
        databases={{ available: ["app", "staging"], observed: null }}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "app" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "staging" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("draws the stored selection, and saves a narrowed one", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ObserveSection
        cluster={cluster}
        databases={{ available: ["app", "staging", "restore"], observed: ["app", "staging"] }}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "restore" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(setObservedDatabases).toHaveBeenCalledWith({ clusterId: "c1", databases: ["app"] });
  });

  // Ticking the last box is "all of them", which has to be storable as null —
  // otherwise a cluster re-widened today silently stops at today's databases.
  it("saves null when every box ends up ticked", async () => {
    setObservedDatabases.mockResolvedValue({ id: "c1", observedDatabases: null });
    const user = userEvent.setup();
    renderInApp(
      <ObserveSection
        cluster={cluster}
        databases={{ available: ["app", "staging"], observed: ["app"] }}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(setObservedDatabases).toHaveBeenCalledWith({ clusterId: "c1", databases: null });
    expect(toastSuccess).toHaveBeenCalledWith("Observing every database on this cluster");
  });

  it("will not save an empty selection", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ObserveSection
        cluster={cluster}
        databases={{ available: ["app", "staging"], observed: ["app"] }}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "app" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Pick at least one database/)).toBeInTheDocument();
  });

  // The cost of an allowlist, said on the screen rather than discovered in six
  // months when a new service gets no recommendations.
  it("says that a database added later will not be observed", () => {
    renderInApp(
      <ObserveSection
        cluster={cluster}
        databases={{ available: ["app", "staging"], observed: ["app"] }}
      />,
    );

    expect(screen.getByText(/will not be either until you tick it here/)).toBeInTheDocument();
  });

  // A one-database cluster still gets an answer. Drawing nothing would read as a
  // missing feature rather than as "there is nothing to choose".
  it("says so instead of drawing boxes when there is one database", () => {
    renderInApp(
      <ObserveSection cluster={cluster} databases={{ available: ["app"], observed: null }} />,
    );

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/has one database/)).toBeInTheDocument();
  });

  // The provisioned login's grants were made against the databases selected when
  // it was created, and there is no admin string left to widen them with.
  it("warns about the provisioned login only when the selection widens", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ObserveSection
        cluster={provisioned}
        databases={{ available: ["app", "staging", "restore"], observed: ["app", "staging"] }}
      />,
    );

    // Narrowing cannot meet a missing grant.
    await user.click(screen.getByRole("checkbox", { name: "staging" }));
    expect(
      screen.queryByText("This cluster runs as a user Indexterity created"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "restore" }));
    expect(screen.getByText("This cluster runs as a user Indexterity created")).toBeInTheDocument();
  });

  // A stored name the cluster no longer reports. Not an error and not pruned — the
  // collect intersects each time — but this is the only place a reader can see it.
  it("reports a selected database the cluster no longer has", () => {
    renderInApp(
      <ObserveSection
        cluster={cluster}
        databases={{ available: ["app"], observed: ["app", "staging"] }}
      />,
    );

    expect(screen.getByText(/no longer on this/)).toBeInTheDocument();
  });
});

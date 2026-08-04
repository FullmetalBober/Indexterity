import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { AuthForm } from "./auth-form";

const signIn = vi.hoisted(() => vi.fn());
const signUp = vi.hoisted(() => vi.fn());
const requestPasswordReset = vi.hoisted(() => vi.fn());

vi.mock("~/lib/auth", () => ({ signIn, signUp, requestPasswordReset }));

beforeEach(() => {
  signIn.mockResolvedValue({ ok: true });
  signUp.mockResolvedValue({ ok: true });
  requestPasswordReset.mockResolvedValue({ ok: true });
});

describe("AuthForm", () => {
  it("signs in with what was typed", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderInApp(<AuthForm onDone={onDone} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(signIn).toHaveBeenCalledWith({ data: { email: "a@b.test", password: "hunter2" } });
    expect(onDone).toHaveBeenCalled();
  });

  // Sign-up asks for a name; sign-in must not, and must not send one.
  it("asks for a name only when creating an account", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onDone={vi.fn()} />);
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(signUp).toHaveBeenCalledWith({
      data: { email: "ada@b.test", password: "hunter2", name: "Ada" },
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("keeps the reader on the form and shows why when credentials are wrong", async () => {
    signIn.mockResolvedValue({ ok: false, error: "invalid email or password" });
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderInApp(<AuthForm onDone={onDone} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("invalid email or password")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  // This instance ships invite-only, so "sign-up is invite-only" is the most
  // likely rejection a stranger will hit — it has to say what to do next.
  it("offers a way forward when sign-up is invite-only", async () => {
    signUp.mockResolvedValue({ ok: false, error: "sign-up is invite-only — ask an owner" });
    const user = userEvent.setup();
    renderInApp(<AuthForm onDone={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Email"), "stranger@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    const link = await screen.findByRole("link", { name: "request access" });
    expect(link).toHaveAttribute("href", expect.stringContaining("mailto:"));
  });

  it("does not offer that on an ordinary failure", async () => {
    signUp.mockResolvedValue({ ok: false, error: "that email is already registered" });
    const user = userEvent.setup();
    renderInApp(<AuthForm onDone={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("that email is already registered")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "request access" })).not.toBeInTheDocument();
  });

  // The reset notice must be the same whether or not the account exists —
  // otherwise the form is an account-enumeration oracle.
  it("gives the same answer to a reset request whatever the account", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onDone={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "who@b.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(requestPasswordReset).toHaveBeenCalledWith({ data: "who@b.test" });
    expect(await screen.findByText(/If that email has an account/)).toBeInTheDocument();
  });

  it("recovers from a reset request that never reached the api", async () => {
    requestPasswordReset.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    renderInApp(<AuthForm onDone={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.type(screen.getByLabelText("Email"), "who@b.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("request failed")).toBeInTheDocument();
    // Still usable — not stuck behind a disabled button.
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeEnabled();
  });
});

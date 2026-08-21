import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { AuthForm } from "./auth-form";

const signIn = vi.hoisted(() => vi.fn());
const signUp = vi.hoisted(() => vi.fn());
const requestPasswordReset = vi.hoisted(() => vi.fn());
const verifyTotp = vi.hoisted(() => vi.fn());
const verifyBackupCode = vi.hoisted(() => vi.fn());
const verifyOtp = vi.hoisted(() => vi.fn());
const sendOtp = vi.hoisted(() => vi.fn());
const sendVerificationEmail = vi.hoisted(() => vi.fn());

// better-auth's own client, which is what the form now talks to — no relay in
// between. It answers with { data, error } rather than throwing, so a refusal
// is a resolved promise carrying the api's message.
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    signIn: { email: signIn },
    signUp: { email: signUp },
    requestPasswordReset,
    twoFactor: { verifyTotp, verifyBackupCode, verifyOtp, sendOtp },
    sendVerificationEmail,
  },
}));

// A token, because that is what a real success carries — and its ABSENCE is
// better-auth's answer for an account that must confirm its address first, which
// the form now reads (#306). Left as `{}` this fixture asserted the old bug.
const OK = { data: { token: "session-token" }, error: null };
// A sign-up on an install requiring verification: created, deliberately no
// session.
const NO_SESSION = { data: { user: { id: "u1" }, token: null }, error: null };
const UNVERIFIED = {
  data: null,
  error: { message: "Email not verified", code: "EMAIL_NOT_VERIFIED", status: 403 },
};

beforeEach(() => {
  signIn.mockResolvedValue(OK);
  signUp.mockResolvedValue(OK);
  requestPasswordReset.mockResolvedValue(OK);
  verifyTotp.mockResolvedValue(OK);
  verifyBackupCode.mockResolvedValue(OK);
  verifyOtp.mockResolvedValue(OK);
  sendOtp.mockResolvedValue(OK);
  sendVerificationEmail.mockResolvedValue(OK);
});

describe("AuthForm", () => {
  it("signs in with what was typed", async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(signIn).toHaveBeenCalledWith({ email: "a@b.test", password: "hunter2-ok" });
    expect(onSignedIn).toHaveBeenCalled();
  });

  // Sign-up asks for a name; sign-in must not, and must not send one.
  it("asks for a name only when creating an account", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(signUp).toHaveBeenCalledWith({
      email: "ada@b.test",
      password: "hunter2-ok",
      name: "Ada",
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("keeps the reader on the form and shows why when credentials are wrong", async () => {
    signIn.mockResolvedValue({ data: null, error: { message: "invalid email or password" } });
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("invalid email or password")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  // This instance ships invite-only, so "sign-up is invite-only" is the most
  // likely rejection a stranger will hit — it has to say what to do next.
  it("offers a way forward when sign-up is invite-only", async () => {
    signUp.mockResolvedValue({
      data: null,
      error: { message: "sign-up is invite-only — ask an owner" },
    });
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Stranger");
    await user.type(screen.getByLabelText("Email"), "stranger@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    const link = await screen.findByRole("link", { name: "request access" });
    expect(link).toHaveAttribute("href", expect.stringContaining("mailto:"));
  });

  it("does not offer that on an ordinary failure", async () => {
    signUp.mockResolvedValue({
      data: null,
      error: { message: "that email is already registered" },
    });
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("that email is already registered")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "request access" })).not.toBeInTheDocument();
  });

  // The reset notice must be the same whether or not the account exists —
  // otherwise the form is an account-enumeration oracle.
  it("gives the same answer to a reset request whatever the account", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "who@b.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    // The reset link lands on this app's page. The origin is named by the
    // browser now that nothing relays the call server-side; better-auth refuses
    // a redirect target outside its trusted origins, which is the check that
    // was doing the work all along.
    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: "who@b.test",
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(await screen.findByText(/If that email has an account/)).toBeInTheDocument();
  });

  it("recovers from a reset request that never reached the api", async () => {
    requestPasswordReset.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.type(screen.getByLabelText("Email"), "who@b.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("request failed")).toBeInTheDocument();
    // Still usable — not stuck behind a disabled button.
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeEnabled();
  });

  // The rule is better-auth's, read off the api's own input schema, so the field
  // refuses exactly what the api would rather than sending it and relaying a 400.
  it("refuses a password the api would refuse, without asking the api", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("At least 8 characters")).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("says an email is not an email before submitting one", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("That does not look like an email address")).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  // Sign-up's extra rule is sign-up's alone: an empty name must not keep someone
  // out of the sign-in form they switched back to.
  it("retires the rules of the mode it left", async () => {
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    expect(await screen.findByText("What should we call you?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Have an account? Sign in" }));
    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(signIn).toHaveBeenCalledWith({ email: "a@b.test", password: "hunter2-ok" });
  });

  // The password was right, the session does not exist yet: the code IS the
  // rest of the sign-in (#55), so the form must not report success and must
  // not strand the reader.
  it("asks for the code when the account has a second factor, then signs in", async () => {
    signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onSignedIn).not.toHaveBeenCalled();
    expect(await screen.findByText("Enter your verification code")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByLabelText("Trust this browser for 30 days"));
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: true });
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("takes a backup code when the device is gone", async () => {
    signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await user.click(
      await screen.findByRole("button", { name: "Lost the device? Use a backup code" }),
    );
    await user.type(screen.getByLabelText("Backup code"), "abcde12345");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(verifyBackupCode).toHaveBeenCalledWith({ code: "abcde12345", trustDevice: false });
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("shows the api's refusal of a wrong code and stays on the code step", async () => {
    signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    verifyTotp.mockResolvedValue({ data: null, error: { message: "invalid two factor code" } });
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("Authenticator code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText("invalid two factor code")).toBeInTheDocument();
    expect(screen.getByLabelText("Authenticator code")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  // The emailed code is a request and then an entry, so the step between them
  // has to be visible — silence between the click and the inbox is what makes
  // somebody click twice and burn the first code.
  it("emails a code on request, says so, and verifies it against the OTP endpoint", async () => {
    signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await user.click(await screen.findByRole("button", { name: "Email me a code instead" }));
    expect(sendOtp).toHaveBeenCalled();
    expect(await screen.findByText(/Code sent/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Emailed code"), "654321");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(verifyOtp).toHaveBeenCalledWith({ code: "654321", trustDevice: false });
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(onSignedIn).toHaveBeenCalled();
  });

  // A deployment with no SMTP refuses, and its reason is the only thing that
  // tells the reader to stop waiting for mail that is not coming.
  it("shows the api's reason when the deployment cannot send email", async () => {
    signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    sendOtp.mockResolvedValue({
      data: null,
      error: { message: "this deployment cannot send email — use your authenticator app" },
    });
    const user = userEvent.setup();
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: "Email me a code instead" }));

    expect(await screen.findByText(/cannot send email/)).toBeInTheDocument();
    // Still on the authenticator field: nothing was sent, so nothing changed.
    expect(screen.getByLabelText("Authenticator code")).toBeInTheDocument();
  });
});

// The four defects of #306, each pinned. All were reachable in production: the
// hosted deployment answered 200 to a sign-up, reported it as signed in, fanned
// out four org-level reads that every one 401'd, and left the owner with no way
// to ask for the mail again.
describe("AuthForm — an address that has not been confirmed", () => {
  it("does not report a session-less sign-up as signed in", async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    signUp.mockResolvedValue(NO_SESSION);
    renderInApp(<AuthForm onSignedIn={onSignedIn} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(onSignedIn).not.toHaveBeenCalled();
    expect(await screen.findByText("Confirm your email")).toBeInTheDocument();
  });

  // Naming it is the point: the commonest cause of "it never arrived" is that it
  // went somewhere else, and the reader cannot check an address nobody showed
  // them.
  it("names the address it mailed", async () => {
    const user = userEvent.setup();
    signUp.mockResolvedValue(NO_SESSION);
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("ada@b.test")).toBeInTheDocument();
  });

  // The 403 half. Same destination, because the reader's next move is identical.
  it("sends a refused sign-in to the same place instead of a bare failure", async () => {
    const user = userEvent.setup();
    signIn.mockResolvedValue(UNVERIFIED);
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Confirm your email")).toBeInTheDocument();
    expect(screen.getByText("ada@b.test")).toBeInTheDocument();
  });

  it("resends to the address it named", async () => {
    const user = userEvent.setup();
    signIn.mockResolvedValue(UNVERIFIED);
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: "Send it again" }));

    expect(sendVerificationEmail).toHaveBeenCalledWith({ email: "ada@b.test" });
    expect(await screen.findByText(/Sent again/)).toBeInTheDocument();
  });

  // The whole point of defect 4: this is the one path where a send that failed
  // can be reported to the person waiting for it. An install with no SMTP is
  // refused here by name.
  it("shows the api's refusal when the deployment cannot send mail", async () => {
    const user = userEvent.setup();
    signIn.mockResolvedValue(UNVERIFIED);
    sendVerificationEmail.mockResolvedValue({
      data: null,
      error: { message: "this deployment cannot send email", code: "EMAIL_NOT_CONFIGURED" },
    });
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: "Send it again" }));

    expect(await screen.findByText(/cannot send email/)).toBeInTheDocument();
  });

  it("offers a way back when the address was wrong", async () => {
    const user = userEvent.setup();
    signUp.mockResolvedValue(NO_SESSION);
    renderInApp(<AuthForm onSignedIn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Need an account? Sign up" }));
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "typo@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.click(await screen.findByRole("button", { name: "Use a different address" }));

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByText("Confirm your email")).not.toBeInTheDocument();
  });
});

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authOk, renderInApp } from "~/test-utils";
import { AccountSection, describeAgent } from "./account-section";

const updateUser = vi.hoisted(() => vi.fn());
const changeEmail = vi.hoisted(() => vi.fn());
const changePassword = vi.hoisted(() => vi.fn());
const revokeSession = vi.hoisted(() => vi.fn());
const revokeOtherSessions = vi.hoisted(() => vi.fn());
const enableTwoFactor = vi.hoisted(() => vi.fn());
const disableTwoFactor = vi.hoisted(() => vi.fn());
const verifyTotp = vi.hoisted(() => vi.fn());
const generateBackupCodes = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// The mutations call better-auth's client; the reads arrive as props from the
// route, so only the writes need a double.
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    updateUser,
    changeEmail,
    changePassword,
    revokeSession,
    revokeOtherSessions,
    twoFactor: {
      enable: enableTwoFactor,
      disable: disableTwoFactor,
      verifyTotp,
      generateBackupCodes,
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

const currentSession = {
  id: "s1",
  token: "tok-current",
  userId: "u1",
  createdAt: new Date("2026-07-01T10:00:00Z"),
  updatedAt: new Date("2026-08-01T10:00:00Z"),
  expiresAt: new Date("2026-09-01T10:00:00Z"),
  ipAddress: "203.0.113.7",
  userAgent: CHROME_LINUX,
};

const otherSession = {
  ...currentSession,
  id: "s2",
  token: "tok-other",
  createdAt: new Date("2026-06-15T10:00:00Z"),
  updatedAt: new Date("2026-07-15T10:00:00Z"),
  ipAddress: "198.51.100.9",
  userAgent: FIREFOX_WINDOWS,
};

const me = {
  user: {
    id: "u1",
    name: "Owner One",
    email: "owner@acme.test",
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  },
  session: currentSession,
};

const bothProviders = [{ providerId: "credential" }, { providerId: "github" }];

function renderSection(
  overrides: Partial<{
    sessions: (typeof currentSession)[];
    accounts: { providerId: string }[];
    me: typeof me;
  }> = {},
) {
  return renderInApp(
    <AccountSection
      me={overrides.me ?? me}
      sessions={overrides.sessions ?? [currentSession, otherSession]}
      accounts={overrides.accounts ?? bothProviders}
    />,
  );
}

const TOTP_URI =
  "otpauth://totp/Indexterity:owner%40acme.test?secret=JBSWY3DPEHPK3PXP&issuer=Indexterity";
const BACKUP_CODES = ["aaaaa11111", "bbbbb22222", "ccccc33333"];

beforeEach(() => {
  vi.clearAllMocks();
  updateUser.mockResolvedValue(authOk({ status: true }));
  changeEmail.mockResolvedValue(authOk({ status: true }));
  changePassword.mockResolvedValue(authOk({ token: null, user: me.user }));
  revokeSession.mockResolvedValue(authOk({ status: true }));
  revokeOtherSessions.mockResolvedValue(authOk({ status: true }));
  enableTwoFactor.mockResolvedValue(authOk({ totpURI: TOTP_URI, backupCodes: BACKUP_CODES }));
  disableTwoFactor.mockResolvedValue(authOk({ status: true }));
  verifyTotp.mockResolvedValue(authOk({ status: true }));
  generateBackupCodes.mockResolvedValue(authOk({ backupCodes: BACKUP_CODES }));
});

describe("profile", () => {
  it("shows the email with its verification state", () => {
    renderSection();
    expect(screen.getByText("owner@acme.test")).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it("submits a new name", async () => {
    const user = userEvent.setup();
    renderSection();
    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("Owner One");
    await user.clear(name);
    await user.type(name, "Owner Two");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateUser).toHaveBeenCalledWith({ name: "Owner Two" });
  });

  it("refuses an empty name without calling the api", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.clear(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("What should we call you?")).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });

  // The address is the identity: the form exists now (#83), lands back on the
  // account page, and says what the chain does before anything is sent.
  it("requests an email change and says what happens next", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Change email" }));
    // A verified account's chain starts at the current address.
    expect(screen.getByText(/current address approves the change/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("New email"), "next@acme.test");
    await user.click(screen.getByRole("button", { name: "Request change" }));

    expect(changeEmail).toHaveBeenCalledWith({
      newEmail: "next@acme.test",
      callbackURL: "/app/account",
    });
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Change requested"));
  });

  it("tells an unverified account the change is immediate", async () => {
    const user = userEvent.setup();
    renderSection({ me: { ...me, user: { ...me.user, emailVerified: false } } });

    await user.click(screen.getByRole("button", { name: "Change email" }));
    expect(screen.getByText(/changes at once/)).toBeInTheDocument();
  });

  it("refuses a non-address before submitting one", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Change email" }));
    await user.type(screen.getByLabelText("New email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Request change" }));

    expect(await screen.findByText("That does not look like an email address")).toBeInTheDocument();
    expect(changeEmail).not.toHaveBeenCalled();
  });

  // The gate's 403 names the rule; "failed" would send the reader hunting a
  // typo they did not make.
  it("shows the signup gate's own refusal", async () => {
    changeEmail.mockResolvedValue({
      data: null,
      error: { status: 403, message: "sign-up is invite-only — ask an owner", code: "FORBIDDEN" },
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Change email" }));
    await user.type(screen.getByLabelText("New email"), "next@gated.test");
    await user.click(screen.getByRole("button", { name: "Request change" }));

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("invite-only"));
  });
});

describe("password", () => {
  it("submits the change with the sign-out-others choice", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.type(screen.getByLabelText("Repeat it"), "new-password-1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password",
      newPassword: "new-password-1",
      // Checked by default: the reader changing a leaked password is the case
      // the checkbox exists for.
      revokeOtherSessions: true,
    });
  });

  it("drops the cached token the current-session mark is judged against", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderSection();
    // Both reads are stale after a change that can rotate the session: the list
    // holds dead sessions, and "me" holds the token the current row is marked
    // against.
    queryClient.setQueryData(["me"], me);
    queryClient.setQueryData(["my-sessions"], [currentSession]);
    await user.type(screen.getByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.type(screen.getByLabelText("Repeat it"), "new-password-1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(changePassword).toHaveBeenCalled();
    expect(queryClient.getQueryState(["me"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["my-sessions"])?.isInvalidated).toBe(true);
  });

  it("refuses a mismatched confirmation without calling the api", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.type(screen.getByLabelText("Repeat it"), "something-else");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("The two do not match")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("offers no form to an account without a password", () => {
    renderSection({ accounts: [{ providerId: "github" }] });
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByText(/no password on this account/)).toBeInTheDocument();
  });
});

describe("two-factor", () => {
  // Enrolment is three steps and nothing is on until the middle one: the
  // password buys the secret, the first code proves the app has it, and only
  // then are the backup codes worth saving.
  it("enrols: password, QR + manual key, first code, then the codes once", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText("Your password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Enable two-factor" }));
    expect(enableTwoFactor).toHaveBeenCalledWith({ password: "hunter2-ok" });

    // The manual key, for the phone that cannot scan.
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456" });

    // Shown once, with the warning attached.
    expect(await screen.findByText("aaaaa11111")).toBeInTheDocument();
    expect(screen.getByText(/only time they are shown/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "I saved them" }));
    expect(screen.queryByText("aaaaa11111")).not.toBeInTheDocument();
  });

  it("closing enrolment before the first code enables nothing", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.type(screen.getByLabelText("Your password"), "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(verifyTotp).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enable two-factor" })).toBeInTheDocument();
  });

  it("offers disable and regeneration when it is on, each behind the password", async () => {
    const user = userEvent.setup();
    renderSection({ me: { ...me, user: { ...me.user, twoFactorEnabled: true } } });

    const gates = screen.getAllByLabelText("Your password");
    await user.type(gates[0] as HTMLElement, "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Regenerate backup codes" }));
    expect(generateBackupCodes).toHaveBeenCalledWith({ password: "hunter2-ok" });
    expect(await screen.findByText("aaaaa11111")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I saved them" }));

    const gatesAgain = screen.getAllByLabelText("Your password");
    await user.type(gatesAgain[1] as HTMLElement, "hunter2-ok");
    await user.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    expect(disableTwoFactor).toHaveBeenCalledWith({ password: "hunter2-ok" });
  });

  // The rule the api enforces is per credential account; an account with no
  // password cannot enrol a code and must not be told to.
  it("tells a GitHub-only account why there is nothing to enable", () => {
    renderSection({ accounts: [{ providerId: "github" }] });
    expect(screen.getByText(/GitHub, which enforces its own second factor/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable two-factor" })).not.toBeInTheDocument();
  });

  // The recovery story is words on the page, not a hidden support process:
  // the last owner who loses device AND codes needs to know what happens next
  // before it happens.
  it("says what happens when both the device and the codes are gone", () => {
    renderSection({ me: { ...me, user: { ...me.user, twoFactorEnabled: true } } });
    expect(screen.getByText(/Whoever runs this install can reset two-factor/)).toBeInTheDocument();
  });
});

describe("sessions", () => {
  it("marks the current session and offers no revoke on it", () => {
    renderSection();
    expect(screen.getByText("this device")).toBeInTheDocument();
    // One other session, so exactly one per-row revoke.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("revokes another session by its token", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeSession).toHaveBeenCalledWith({ token: "tok-other" });
  });

  it("signs out everything else in one go", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Sign out other sessions" }));
    expect(revokeOtherSessions).toHaveBeenCalledWith();
  });

  it("offers no sign-out-others with a single session", () => {
    renderSection({ sessions: [currentSession] });
    expect(
      screen.queryByRole("button", { name: "Sign out other sessions" }),
    ).not.toBeInTheDocument();
  });
});

describe("describeAgent", () => {
  it.each([
    [CHROME_LINUX, "Chrome on Linux"],
    [FIREFOX_WINDOWS, "Firefox on Windows"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "Safari on iOS",
    ],
    ["curl/8.9.0", "Unknown device"],
    ["", "Unknown device"],
    [null, "Unknown device"],
  ])("%s → %s", (userAgent, expected) => {
    expect(describeAgent(userAgent)).toBe(expected);
  });
});

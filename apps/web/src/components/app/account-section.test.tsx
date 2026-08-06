import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authOk, renderInApp } from "~/test-utils";
import { AccountSection, describeAgent } from "./account-section";

const updateUser = vi.hoisted(() => vi.fn());
const changePassword = vi.hoisted(() => vi.fn());
const revokeSession = vi.hoisted(() => vi.fn());
const revokeOtherSessions = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

// The mutations call better-auth's client; the reads arrive as props from the
// route, so only the four writes need a double.
vi.mock("~/lib/auth-client", () => ({
  authClient: { updateUser, changePassword, revokeSession, revokeOtherSessions },
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
  }> = {},
) {
  return renderInApp(
    <AccountSection
      me={me}
      sessions={overrides.sessions ?? [currentSession, otherSession]}
      accounts={overrides.accounts ?? bothProviders}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  updateUser.mockResolvedValue(authOk({ status: true }));
  changePassword.mockResolvedValue(authOk({ token: null, user: me.user }));
  revokeSession.mockResolvedValue(authOk({ status: true }));
  revokeOtherSessions.mockResolvedValue(authOk({ status: true }));
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

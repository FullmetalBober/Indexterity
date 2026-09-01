import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authOk, renderInApp } from "~/test-utils";
import { VerificationOutcome } from "./verification-outcome";

const sendVerificationEmail = vi.hoisted(() => vi.fn());

// The real client with only the calls these tests make replaced. A factory
// returning a bare `{ authClient: { … } }` swaps the WHOLE module and leaves the
// rest of better-auth's client undefined, and nothing checked the replacements
// against the methods they stand in for.
vi.mock("~/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth-client")>();
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      sendVerificationEmail,
    },
  };
});
// Only Link is used here, and rendering it needs a router this test has no
// reason to stand up — the same shortcut every other component test takes.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { anchorLink, overriding } = await import("~/lib/overriding");
  return overriding(actual, { Link: anchorLink });
});

beforeEach(() => {
  vi.clearAllMocks();
  sendVerificationEmail.mockResolvedValue(authOk({ status: true }));
});

// The whole point of #324: this page exists so that the two outcomes stop
// looking identical. Each test below is one of the things the marketing page
// could not say.
describe("VerificationOutcome", () => {
  it("says the address is confirmed, and that it did not sign anyone in", () => {
    renderInApp(<VerificationOutcome error="" />);

    expect(screen.getByText("Email confirmed")).toBeInTheDocument();
    // The counter-intuitive half, and the reason autoSignInAfterVerification is
    // deliberately off: somebody who is not told this waits to be let in.
    expect(screen.getByText(/does not sign you in here/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sign-in page/ })).toBeInTheDocument();
    // No resend on a link that worked.
    expect(screen.queryByRole("button", { name: /Send a new link/ })).not.toBeInTheDocument();
  });

  // The failure case is the one that mattered more: an expired link used to be
  // indistinguishable from a successful one, so the reader clicked it again.
  it("names an expired link and offers a fresh one", async () => {
    const user = userEvent.setup();
    renderInApp(<VerificationOutcome error="TOKEN_EXPIRED" />);

    expect(screen.getByText("That link has expired")).toBeInTheDocument();
    expect(screen.queryByText("Email confirmed")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "ada@b.test");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    expect(sendVerificationEmail).toHaveBeenCalledWith({ email: "ada@b.test" });
    // Non-committal on purpose: the api refuses to say whether that address has
    // an account, and this sentence must not say it for them.
    expect(await screen.findByText(/If an account exists for that address/)).toBeInTheDocument();
  });

  it("tells an invalid link apart from an expired one", () => {
    renderInApp(<VerificationOutcome error="INVALID_TOKEN" />);

    expect(screen.getByText("That link is not valid")).toBeInTheDocument();
    // The remedy differs — this one is usually the reader's mail client, so the
    // copy says so rather than only offering another link.
    expect(screen.getByText(/cut short or rewritten/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a new link" })).toBeInTheDocument();
  });

  // Two codes where another email would be a lie or a dead end, so neither
  // offers one.
  it.each(["USER_NOT_FOUND", "INVALID_USER"])("offers no resend for %s", (code) => {
    renderInApp(<VerificationOutcome error={code} />);

    expect(screen.queryByRole("button", { name: "Send a new link" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sign-in page/ })).toBeInTheDocument();
  });

  // better-auth can add codes to this endpoint. Reading an unknown one as
  // success would send somebody to a sign-in that refuses them with the reason
  // now nowhere at all, so the unknown case fails loudly and names the code.
  it("treats an unrecognised code as a failure and prints it", () => {
    renderInApp(<VerificationOutcome error="SOMETHING_NEW" />);

    expect(screen.getByText("That link did not work")).toBeInTheDocument();
    expect(screen.getByText(/SOMETHING_NEW/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a new link" })).toBeInTheDocument();
  });
});

import { expect } from "@playwright/test";
import { PASSWORD, signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// The account page's chain is better-auth's own endpoints end to end: the
// component tests stop at a mocked auth client, so this is the only place a
// changed password is proven to be the one the next sign-in accepts.
test.describe("account page", () => {
  test("renames, changes the password, and the new password is the one that works", async ({
    page,
  }) => {
    const email = uniqueEmail("account");
    await signUpAndLandOnDashboard(page, email);

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("link", { name: "Account" }).click();

    // The profile card knows who this is.
    const name = page.getByLabel("Name", { exact: true });
    await expect(name).toHaveValue("E2E User");
    await expect(page.getByText(email)).toBeVisible();

    // The session signing in right now is on the list, marked as this one.
    await expect(page.getByText("this device")).toBeVisible();

    // Rename.
    await name.fill("E2E Renamed");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Name updated")).toBeVisible();

    // Change the password.
    const newPassword = `${PASSWORD}-2`;
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password").fill(newPassword);
    await page.getByLabel("Repeat it").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    // The old password is dead...
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // ...and the new one is what signs in.
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // The rename survived the round trip to postgres, not just the cache.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("link", { name: "Account" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E Renamed");
  });

  // The change-email chain, on the immediate flow this stack runs (#83): no
  // REQUIRE_EMAIL_VERIFICATION, so the account is unverified and the address
  // flips in the request — which is exactly the state where sign-in moving
  // with it is provable without a mailbox.
  test("changes the email, and sign-in moves to the new address", async ({ page }) => {
    const email = uniqueEmail("account-email");
    const newEmail = uniqueEmail("account-email-new");
    await signUpAndLandOnDashboard(page, email);

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("link", { name: "Account" }).click();

    await page.getByRole("button", { name: "Change email" }).click();
    // The form says what the chain does before anything is sent.
    await expect(page.getByText(/changes at once/)).toBeVisible();
    await page.getByLabel("New email").fill(newEmail);
    await page.getByRole("button", { name: "Request change" }).click();
    await expect(
      page.getByText("Change requested — the emails say what happens next"),
    ).toBeVisible();

    // The profile card shows the new address once "me" refetches.
    await expect(page.getByText(newEmail)).toBeVisible();

    // The old address is dead...
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // ...and the new one is the account.
    await page.getByLabel("Email").fill(newEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});

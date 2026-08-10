import { expect } from "@playwright/test";
import { PASSWORD, signUpAndLandOnDashboard, test, totpCode, uniqueEmail } from "./fixtures";

// The whole second factor, end to end and through the UI only (#55): enrol by
// reading the manual key off the screen, prove the first code, save a backup
// code, then sign in with a TOTP and once more with the backup code. The
// component tests stop at a mocked auth client — this is where the QR screen,
// better-auth's totp verify and the sign-in interlock are proven against the
// real api.
test.describe("two-factor authentication", () => {
  test("enrols from the account page, then both code kinds sign in", async ({ page }) => {
    const email = uniqueEmail("twofactor");
    await signUpAndLandOnDashboard(page, email);

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("link", { name: "Account" }).click();

    // Enrol. The password gate is the two-factor card's own (the change-password
    // form has "Current password"; this one is "Your password").
    await page.getByLabel("Your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Enable two-factor" }).click();

    // The manual-entry key doubles as the test's authenticator secret.
    await expect(page.getByText("Can't scan it?")).toBeVisible();
    const secret = (await page
      .locator("code", { hasText: /^[A-Z2-7]{16,}$/ })
      .first()
      .textContent()) as string;

    await page.getByLabel("Authenticator code").fill(totpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Two-factor authentication is on")).toBeVisible();

    // Backup codes appear exactly once; keep one before dismissing them.
    await expect(page.getByText(/only time they are shown/)).toBeVisible();
    const backupCode = (await page
      .locator("code", { hasText: /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/ })
      .first()
      .textContent()) as string;
    await page.getByRole("button", { name: "I saved them" }).click();
    await expect(page.getByRole("button", { name: "Turn off two-factor" })).toBeVisible();

    // Password alone no longer signs in — the code step is the rest of it.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your verification code")).toBeVisible();
    await page.getByLabel("Authenticator code").fill(totpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // And the backup code carries a lost device through the same door.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Lost the device? Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(backupCode);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});

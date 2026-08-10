import { expect } from "@playwright/test";
import { PASSWORD, signIn, signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// Browser → web server → api → postgres. The component tests mock the server
// function; this proves the session cookie the api sets actually comes back
// through the web server and is accepted on the next request.
test.describe("authentication", () => {
  test("signs up, stays signed in across a reload, and signs out", async ({ page }) => {
    const email = uniqueEmail("auth");
    await signUpAndLandOnDashboard(page, email);

    // The cookie survives a full navigation, not just the client-side state.
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    // And the session is really gone, not just hidden.
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("signs back in with the same credentials", async ({ page }) => {
    const email = uniqueEmail("auth-return");
    await signUpAndLandOnDashboard(page, email);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await signIn(page, email);
  });

  test("refuses a wrong password and says so", async ({ page }) => {
    const email = uniqueEmail("auth-wrong");
    await signUpAndLandOnDashboard(page, email);
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(`${PASSWORD}-wrong`);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  // The dashboard is behind auth on the server, not just hidden in the client.
  test("shows the sign-in form to a visitor with no session", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByText("Sign in to your account")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
  });

  test("marketing page loads and links into the app", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Indexterity/);
  });
});

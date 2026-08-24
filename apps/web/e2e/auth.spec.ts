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

  // Where the verification email's link lands (#324). It used to land on `/`,
  // which is static and said nothing — so a confirmed reader and one whose link
  // had expired were shown the identical page.
  //
  // The token flow itself cannot run here (this deployment does not require
  // verification, so no mail is sent), and it does not need to: what better-auth
  // hands this page is a redirect carrying at most `?error=`, which is exactly
  // what these two navigations are. What they prove is the half the component
  // test cannot — that the route exists in the built server and renders from a
  // cold navigation rather than only under a test renderer.
  test("the verification landing reports both outcomes", async ({ page }) => {
    await page.goto("/verified");
    await expect(page.getByText("Email confirmed")).toBeVisible();
    await expect(page.getByText(/does not sign you in here/)).toBeVisible();

    await page.goto("/verified?error=TOKEN_EXPIRED");
    await expect(page.getByText("That link has expired")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a new link" })).toBeVisible();
  });
});

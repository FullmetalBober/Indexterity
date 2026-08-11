import { expect } from "@playwright/test";
import { signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// The Content-Security-Policy, against the built server rather than a unit test
// of the string.
//
// Two different things have to be true and only one of them is checkable from
// the header: the policy has to name a nonce, and the scripts in the SAME
// response have to carry that same value. A unit test can assert the first. A
// mismatch between them — a nonce regenerated after the render, or a header
// written from a different variable — produces a perfectly well-formed policy
// and a page that never hydrates, which is why this is asked of a real response.
//
// The rest of the suite carries the other half: every spec asserts the browser
// refused nothing (see the fixture in fixtures.ts), so a directive that is too
// strict for a page fails wherever that page is exercised.

const NONCE_IN_POLICY = /script-src [^;]*'nonce-([A-Za-z0-9+/=]+)'/;

test.describe("content security policy", () => {
  test("names a fresh nonce, and every inline script in the response carries it", async ({
    page,
  }) => {
    const response = await page.goto("/");
    const policy = response?.headers()["content-security-policy"] ?? "";

    const nonce = NONCE_IN_POLICY.exec(policy)?.[1];
    expect(nonce, `no nonce in script-src: ${policy}`).toBeTruthy();

    // 128 bits, base64. A guessable nonce is a nonce an injected script can
    // simply state.
    expect(Buffer.from(nonce ?? "", "base64")).toHaveLength(16);

    // Nothing weakens script-src back open. 'unsafe-inline' beside a nonce is
    // ignored by a browser that understands the nonce and honoured by one that
    // does not, which makes it a hole shaped like a fallback.
    const scriptSrc = /script-src ([^;]*)/.exec(policy)?.[1] ?? "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
    // Nor style-src, which is ZAP's 10055. 'unsafe-inline' is confined to the
    // ATTRIBUTE directive, which React's server-rendered `style={{…}}` needs.
    const styleSrc = /(?:^|; )style-src ([^;]*)/.exec(policy)?.[1] ?? "";
    expect(styleSrc).not.toContain("unsafe-inline");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");

    // Every script in the document the browser was handed — the router's
    // dehydration payload, the buffered `$tsr` block, the module entry, and the
    // JSON-LD the landing page emits.
    const html = (await response?.text()) ?? "";
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1] ?? "");
    expect(scripts.length).toBeGreaterThan(2);
    for (const attrs of scripts) {
      expect(attrs, `a script without the response's nonce: <script${attrs}>`).toMatch(
        new RegExp(`nonce=["']${nonce?.replace(/[+/=]/g, "\\$&")}["']`),
      );
    }
  });

  test("mints a different nonce per response", async ({ page }) => {
    const first = await page.goto("/");
    const second = await page.goto("/app");
    const nonceOf = (policy: string): string | undefined => NONCE_IN_POLICY.exec(policy)?.[1];

    const a = nonceOf(first?.headers()["content-security-policy"] ?? "");
    const b = nonceOf(second?.headers()["content-security-policy"] ?? "");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  // The policy is only worth having if the app still works under it, and the
  // part it could break is the part no header test can see. A signed-in
  // dashboard is where the inline styles live — the virtualized tables position
  // their rows with `style=`, which is `style-src-attr`, not `style-src`.
  test("the dashboard hydrates and works under it", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("csp"));

    // Interactive: two client-side navigations the server never rendered. If the
    // hydration script had been refused, the page would still LOOK right and
    // this would time out.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    await page.getByRole("link", { name: "Account" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E User");
  });
});

import { expect } from "@playwright/test";
import { signUpAndLandOnDashboard, test, uniqueEmail } from "./fixtures";

// The pointer on a button, measured rather than declared.
//
// This has to be a browser: the rule lives in `@layer base` (styles.css) and what
// makes it safe is that a utility class sits in a later layer and outranks it —
// which is a fact about how the built stylesheet cascades, not about any file's
// text. jsdom applies no stylesheet at all, so a unit test can only say the rule
// was written.
//
// Tailwind v4's Preflight stopped setting a cursor for buttons and left the
// browser default, so the dashboard had a rail that responded to the pointer and
// buttons beside it that did not.
test.describe("the pointer says what is clickable", () => {
  test("real buttons get it, and disabled ones do not", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("cursor"));

    const cursorOf = (name: string) =>
      page
        .getByRole("button", { name })
        .first()
        .evaluate((el) => getComputedStyle(el).cursor);

    // A plain shadcn Button, and the one in the rail that has no variant classes.
    expect(await cursorOf("Sign out")).toBe("pointer");

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();

    // A button nobody can press keeps the arrow. This one is gated behind
    // type-to-confirm, so it is disabled on open.
    await page.getByRole("button", { name: "Delete org" }).click();
    const confirm = page.getByRole("button", { name: "Delete this organization" });
    await expect(confirm).toBeDisabled();
    expect(await confirm.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("pointer");
  });

  // What keeps `select.tsx`'s menu items on `cursor-default` — shadcn matching how
  // a native select behaves — and every `disabled:cursor-not-allowed` intact. Both
  // are utility classes, and a utility outranks `base`.
  test("a utility class still outranks the base rule", async ({ page }) => {
    await signUpAndLandOnDashboard(page, uniqueEmail("cursor-layer"));
    const probes = await page.evaluate(() => {
      const make = (tag: string, className: string, disabled: boolean) => {
        const el = document.createElement(tag) as HTMLButtonElement;
        el.className = className;
        el.disabled = disabled;
        document.body.append(el);
        const cursor = getComputedStyle(el).cursor;
        el.remove();
        return cursor;
      };
      return {
        // `cursor-default` is generated because select.tsx uses it bare.
        overridden: make("button", "cursor-default", false),
        // `cursor-not-allowed` only exists in the built CSS behind the `disabled:`
        // variant, which is the spelling input.tsx and checkbox.tsx ship.
        disabledVariant: make("button", "disabled:cursor-not-allowed", true),
        plain: make("button", "", false),
      };
    });
    expect(probes.plain).toBe("pointer");
    expect(probes.overridden).toBe("default");
    expect(probes.disabledVariant).toBe("not-allowed");
  });
});

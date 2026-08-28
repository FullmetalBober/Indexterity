import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// A duplicate React key is a console warning and nothing else: the page renders,
// React reuses the wrong component, and the state of one card can show up in
// another. It shipped once — three sibling cards on a cluster's settings keyed by
// the same cluster id — and the only reason anybody noticed was a browser console
// somebody happened to have open. So it fails a test now.
//
// Narrow on purpose. React logs plenty a test may legitimately provoke, and a
// blanket console.error gate would turn every error-state test into a false
// failure. Collected and thrown in afterEach rather than from inside
// console.error, because throwing there lands in the middle of React's own
// warning path.
const KEY_WARNINGS = /same key|unique "key"/;
const realConsoleError = console.error;
let keyWarnings: string[] = [];

beforeEach(() => {
  keyWarnings = [];
  console.error = (...args: unknown[]) => {
    const text = args.map((arg) => String(arg)).join(" ");
    if (KEY_WARNINGS.test(text)) keyWarnings.push(text);
    realConsoleError(...args);
  };
});

afterEach(() => {
  console.error = realConsoleError;
  if (keyWarnings.length > 0) {
    const seen = keyWarnings.join("\n");
    keyWarnings = [];
    throw new Error(`React reported a duplicate or missing key:\n${seen}`);
  }
});

// jsdom does not implement these, and Radix's primitives call them on open.
// Without them every dialog, select and tooltip test throws instead of failing
// on what it is actually asserting.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false;
  Element.prototype.setPointerCapture = (): void => {};
  Element.prototype.releasePointerCapture = (): void => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => {};
}

// jsdom performs no layout, so every element reports offsetHeight/offsetWidth as
// 0 — and those are the exact two properties TanStack Virtual measures, for both
// the scroll container's viewport and each row's height. Left at zero, a
// virtualized table sees a viewport of nothing, renders no rows, and every test
// about sorting or filtering fails on markup that is correct in a browser.
//
// A plausible scale rather than one number: a 600px container over 40px rows is
// fifteen visible rows, which is what a browser would report and enough for any
// test's fixture to render in full. The virtualization itself is asserted against
// a fixture big enough to exceed it, in data-table.test.tsx.
// Redefined unconditionally, unlike the shims above: jsdom already *has* these
// two, as getters that return 0. There is nothing missing to detect.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement): number {
    return this.tagName === "TR" ? 40 : 600;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(): number {
    return 800;
  },
});

// Each test gets a clean document — otherwise a getByRole in the second test
// finds the first test's markup and the failure makes no sense.
afterEach(() => {
  cleanup();
});

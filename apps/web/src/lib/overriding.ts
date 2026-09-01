import type { Link } from "@tanstack/react-router";
import { createElement } from "react";

// A real object with named members replaced, for the module doubles in the test
// suite.
//
// `vi.mock(path, factory)` swaps the WHOLE module, so a factory that returns
// `{ api: () => ({ renameCluster }) }` leaves every other call undefined — and
// nothing checked `renameCluster` against the call it stands in for. Spreading
// the real thing does not fix it either: `api()` returns an oRPC Proxy over
// fetch, and `{ ...proxy }` is `{}`.
//
// So: a Proxy that forwards. `new Proxy(real, handler)` IS typed as `real`, with
// nothing asserted — unlike `new Proxy({}, handler) as T`, which is the shape
// this replaced. `Partial<T>` checks each override against the member it stands
// in for, so a renamed or re-signatured call stops compiling. And a call the
// test never set up still reaches the real object, which fails out loud instead
// of answering `undefined`.
export function overriding<T extends object>(real: T, overrides: Partial<T>): T {
  return new Proxy(real, {
    get: (target, property) =>
      property in overrides ? Reflect.get(overrides, property) : Reflect.get(target, property),
  });
}

// A `<Link>` that renders a plain anchor, for a component test with no router.
//
// Two test files carried this and a copy-paste detector found it. What is worth
// keeping is not the four lines of JSX but the two things that were got wrong
// first: `props` is left to the CONTEXTUAL type, because TanStack's Link is a
// generic component and a double declaring its own narrower props is not the
// component it stands in for; and a Link's children may be a render FUNCTION,
// which the first version dropped on the floor.
// Annotated as `typeof Link` rather than taking a props parameter of its own:
// that is what hands the body the contextual type, and it is the whole reason
// this compiles. Naming the props directly instantiates the generic at its
// defaults, which is a DIFFERENT component from the one it stands in for.
export const anchorLink: typeof Link = (props) =>
  createElement(
    "a",
    { href: String(props.to) },
    typeof props.children === "function"
      ? props.children({ isActive: false, isTransitioning: false })
      : props.children,
  );

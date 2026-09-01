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

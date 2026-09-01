// `@total-typescript/ts-reset`, which replaces the standard-library types that
// hand back `any`.
//
// THE CANONICAL COPY. Every project needs its own file — a tsconfig only sees
// what its own `include` covers — but the argument does not need repeating five
// times, so the other four are two lines and a pointer here.
//
// The reason it is here rather than in a lint rule: `JSON.parse` returning `any`
// meant an ANNOTATION on its result checked exactly as much as an assertion
// would — nothing — and four of those were in this repo, two of them in the
// security gate. `scripts/lint-assertions.ts` learned to spot the direct form,
// but it cannot see `use(JSON.parse(x))` or a parse behind a helper. This makes
// it `unknown`, so the compiler asks for the narrowing at every one of them.
//
// `Array.isArray` is the other one that bites here: it narrows to `any[]`, which
// re-introduces `any` in the middle of code that never wrote it — including in a
// generic copy helper, where `any[]` looked assignable and was not.
//
// The recommended set, which is the four above plus `.filter(Boolean)`,
// `.includes`/`.indexOf`/`Set.has`/`Map.has` on narrow types, the Map
// constructor and `Promise.catch`.
import "@total-typescript/ts-reset/recommended";

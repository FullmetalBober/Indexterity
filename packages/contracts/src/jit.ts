import { config } from "zod";

// Zod compiles each schema's validator with `new Function` where it can, and
// finds out whether it can by evaluating `Function("")` and catching the
// failure. In a browser under the dashboard's Content-Security-Policy — which
// carries no 'unsafe-eval', by design (apps/web/src/lib/security-headers.ts) —
// that probe is refused. Zod's answer is the right one, the interpreted path,
// but the browser logs a policy violation first, on every page load, for a
// question that was settled before it was asked. A warning only a human can see
// is not a rule (D20), and this one appears in the console of every reader.
//
// Browser only, deliberately: no policy governs the api's own process, and the
// compiled validators are the faster ones — every request it serves parses its
// input with them. Detected from `globalThis` rather than a bundler flag,
// because this package is compiled by tsc for the api and by vite for the
// dashboard and only one of those has `import.meta.env`; and written as `in`
// rather than `typeof document`, because this tsconfig has no DOM lib and
// should not gain one to ask a question about the absence of a browser.
//
// ── Why it lives here, and is imported before anything else ─────────────────
// Zod decides per schema, when the schema is CONSTRUCTED — not at first parse.
// Every schema in this package is built at import time, so this is the only
// place the setting can be guaranteed to precede them: a call anywhere
// downstream, including the dashboard's own entry, runs after ESM has already
// finished evaluating this module graph.
if ("document" in globalThis) config({ jitless: true });

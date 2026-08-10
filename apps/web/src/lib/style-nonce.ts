import { setNonce } from "get-nonce";

// Gives the `react-style-singleton` family this response's nonce, so the style
// elements it writes are allowed by name rather than by `style-src
// 'unsafe-inline'`.
//
// That family is not a direct dependency and is under everything: Radix's
// Dialog, AlertDialog and every popover mount `react-remove-scroll`, which mounts
// `react-remove-scroll-bar`, which writes a `<style>` element containing the
// MEASURED scrollbar width. Its content differs between machines, so a hash
// cannot cover it — but the library already asks `get-nonce` for a nonce before
// inserting, and `setNonce` is how that question gets an answer.
//
// ── Where the value comes from ──────────────────────────────────────────────
// Off the document, from the script tag the server already stamped. Browsers
// hide a nonce from ATTRIBUTE reads — `getAttribute("nonce")` returns `""`,
// measured — precisely so that injected markup cannot read one and reuse it; the
// `.nonce` property still answers, but only to script that is already running,
// which by definition has already satisfied `script-src`. So this reads what only
// trusted code can read, and adds no channel of its own. Nothing is written into
// the HTML for it.
//
// Browser only: on the server nothing inserts these elements, since a closed
// dialog renders no content.
if (!import.meta.env.SSR) {
  const stamped = document.querySelector<HTMLScriptElement>("script[nonce]");
  if (stamped?.nonce) setNonce(stamped.nonce);
}

// This deployment's identity. A fork changes these two constants and nothing
// else — they are deliberately not env-driven, because both are rendered on the
// client too and a value that differs between server and client would cause a
// hydration mismatch (canonical URLs and CTAs must be stable).

// The canonical public home. Overridable at runtime with SITE_URL for staging
// copies — see lib/seo.ts.
export const CANONICAL_ORIGIN = "https://indexterity.alivlad.com";

// Where someone without an account asks for one. Indexterity ships invite-only
// by default (SIGNUP_MODE), so the marketing CTA has to lead somewhere real.
export const CONTACT_EMAIL = "hello@alivlad.com";

export const REQUEST_ACCESS_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  "Indexterity access request",
)}`;

// The page with the exact createRole snippets. Named here rather than inline so
// the onboarding form is not the thing that goes stale when docs move — it
// already pointed at "docs/architecture.md §10.1", which was a path in a
// repository the reader of that sentence has no reason to have open.
export const CLUSTER_USER_DOCS_HREF =
  "https://github.com/FullmetalBober/Indexterity/wiki/Connecting-a-cluster";

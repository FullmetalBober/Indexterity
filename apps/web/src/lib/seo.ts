import { env } from "./env";
import { CANONICAL_ORIGIN } from "./site";

// Canonical and og:url must point at the one indexable copy no matter which
// host served the response (preview deploy, raw service URL, apex vs www), or
// search engines see duplicates — hence a constant rather than WEB_ORIGIN.
// Self-hosters and staging override it with SITE_URL.
//
// SITE_URL is a `server` variable, so the guard is not decoration: these tags
// are rendered during SSR and the head is re-evaluated in the browser, where
// reading one throws. The constant is what the client sees, which is why an
// override changes what is SERVED rather than what the app believes about
// itself.
export function siteOrigin(): string {
  return originFrom(typeof window === "undefined" ? env.SITE_URL : undefined);
}

// The normalising half, pure so it can be stated in a test without a server.
export function originFrom(override: string | undefined): string {
  return (override ?? CANONICAL_ORIGIN).replace(/\/+$/, "");
}

export interface PageSeo {
  readonly title: string;
  readonly description: string;
  // Path only — the origin is prepended.
  readonly path: string;
  readonly image?: string;
}

interface MetaTag {
  readonly title?: string;
  readonly name?: string;
  readonly property?: string;
  readonly content?: string;
}

// Title, description, canonical, Open Graph and Twitter card in one place, so
// no page ships half a set.
export function seoTags(page: PageSeo): {
  meta: MetaTag[];
  links: Array<{ rel: string; href: string }>;
} {
  const origin = siteOrigin();
  const url = `${origin}${page.path}`;
  const image = `${origin}${page.image ?? "/og-card.png"}`;
  return {
    meta: [
      { title: page.title },
      { name: "description", content: page.description },
      { name: "robots", content: "index, follow, max-image-preview:large" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Indexterity" },
      { property: "og:title", content: page.title },
      { property: "og:description", content: page.description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      // Describes the words rendered into og-card.png, so the two move together.
      {
        property: "og:image:alt",
        content: "Indexterity — automatic index management for MongoDB and SQL Server",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: page.title },
      { name: "twitter:description", content: page.description },
      { name: "twitter:image", content: image },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

// Pages behind auth must never be indexed, and must not pass link equity on.
export const NOINDEX_META: MetaTag[] = [{ name: "robots", content: "noindex, nofollow" }];

// JSON-LD, emitted through the router's head `scripts` (no innerHTML). Entries
// are spread as element props, so `type` and `children` sit at the top level.
export function jsonLd(data: Record<string, unknown>): {
  type: string;
  children: string;
} {
  return { type: "application/ld+json", children: JSON.stringify(data) };
}

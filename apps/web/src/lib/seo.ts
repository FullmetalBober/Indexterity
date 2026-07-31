// The canonical public home of the product. Deliberately a constant rather
// than WEB_ORIGIN: canonical and og:url must point at the one indexable copy
// no matter which host served the response (preview deploy, raw service URL,
// apex vs www), or search engines see duplicates. Self-hosters and staging
// override it with SITE_URL.
const CANONICAL_ORIGIN = "https://indexterity.alivlad.com";

export function siteOrigin(): string {
  const override = typeof process === "undefined" ? undefined : process.env.SITE_URL;
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
      { property: "og:image:alt", content: "Indexterity — automatic MongoDB index management" },
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

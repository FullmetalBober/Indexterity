// The app's own public origin, used for canonical and og:url. Runtime
// WEB_ORIGIN wins on the server (the chart sets it); VITE_WEB_ORIGIN is the
// build-time default so client-side renders agree. Keep them the same value.
export function siteOrigin(): string {
  const runtime = typeof process === "undefined" ? undefined : process.env.WEB_ORIGIN;
  return (runtime ?? import.meta.env.VITE_WEB_ORIGIN ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
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

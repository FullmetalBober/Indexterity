import { describe, expect, it } from "vitest";
import { jsonLd, NOINDEX_META, originFrom, seoTags, siteOrigin } from "./seo";

function content(tags: ReturnType<typeof seoTags>, key: string): string | undefined {
  return tags.meta.find((tag) => tag.name === key || tag.property === key)?.content;
}

// SITE_URL is a server variable now (lib/env.ts), read once at boot rather than
// on every call — so the override is exercised through the pure half, and
// siteOrigin() is pinned for the side these tests actually run on.
describe("siteOrigin", () => {
  it("is the canonical origin in the browser, whatever the server was told", () => {
    expect(siteOrigin()).toBe("https://indexterity.alivlad.com");
  });

  it("is the canonical origin when nothing overrides it", () => {
    expect(originFrom(undefined)).toBe("https://indexterity.alivlad.com");
  });

  it("lets a staging copy override it", () => {
    expect(originFrom("https://staging.example.com")).toBe("https://staging.example.com");
  });

  // A trailing slash would produce "https://x.com//pricing" in every canonical.
  it("strips trailing slashes so joined paths stay well-formed", () => {
    expect(originFrom("https://staging.example.com///")).toBe("https://staging.example.com");
  });
});

describe("seoTags", () => {
  const page = { title: "Pricing — Indexterity", description: "What it costs", path: "/pricing" };

  // Duplicate content is the failure this guards: the canonical must point at
  // the one indexable copy no matter which host served the response.
  it("points canonical and og:url at the same absolute URL", () => {
    const tags = seoTags(page);
    const expected = "https://indexterity.alivlad.com/pricing";
    expect(tags.links).toContainEqual({ rel: "canonical", href: expected });
    expect(content(tags, "og:url")).toBe(expected);
  });

  it("ships a complete card, not half a set", () => {
    const tags = seoTags(page);
    for (const key of [
      "description",
      "og:title",
      "og:description",
      "og:image",
      "twitter:card",
      "twitter:title",
      "twitter:image",
    ]) {
      expect(content(tags, key)).toBeTruthy();
    }
    expect(tags.meta[0]?.title).toBe(page.title);
  });

  it("makes the social image absolute, with a default", () => {
    expect(content(seoTags(page), "og:image")).toBe("https://indexterity.alivlad.com/og-card.png");
    expect(content(seoTags({ ...page, image: "/custom.png" }), "og:image")).toBe(
      "https://indexterity.alivlad.com/custom.png",
    );
  });

  it("asks to be indexed", () => {
    expect(content(seoTags(page), "robots")).toContain("index, follow");
  });
});

// Anything behind auth. Getting this wrong puts a customer's dashboard URL in
// a search index.
describe("NOINDEX_META", () => {
  it("refuses indexing and link equity both", () => {
    expect(NOINDEX_META[0]?.content).toBe("noindex, nofollow");
  });
});

describe("jsonLd", () => {
  // Emitted through the router's head scripts, not innerHTML — so the payload
  // has to arrive already serialized.
  it("serializes to a script the router can spread as props", () => {
    const script = jsonLd({ "@type": "Organization", name: "Indexterity" });
    expect(script.type).toBe("application/ld+json");
    expect(JSON.parse(script.children)).toEqual({
      "@type": "Organization",
      name: "Indexterity",
    });
  });
});

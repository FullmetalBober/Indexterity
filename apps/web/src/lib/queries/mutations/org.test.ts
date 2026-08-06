import { describe, expect, it } from "vitest";
import { slugify } from "./org";

// The slug is never shown and nothing routes by it — it exists because
// better-auth's organization plugin resolves organizations by one and requires
// it to be unique. So the bar is not "pretty": it is that a name a person would
// actually type produces something the api's own check accepts, because the
// alternative is a create button that fails on a name nobody can see the
// problem with.
//
// Same expression as ORG_SLUG in @repo/contracts, which is what the api's
// beforeCreateOrganization hook tests against.
const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

describe("slugify", () => {
  it("lowercases and hyphenates the ordinary case", () => {
    expect(slugify("Acme")).toBe("acme");
    expect(slugify("Acme Data Co")).toBe("acme-data-co");
  });

  it("collapses punctuation rather than smuggling it through", () => {
    expect(slugify("Acme, Inc.")).toBe("acme-inc");
    expect(slugify("  spaced   out  ")).toBe("spaced-out");
    expect(slugify("a---b")).toBe("a-b");
  });

  // A name in a script with no ASCII at all still has to produce something the
  // api will accept, or the create button refuses a perfectly good name.
  it("never produces something the api would reject", () => {
    for (const name of [
      "Acme",
      "Acme, Inc.",
      "-leading",
      "trailing-",
      "工程部",
      "Ünïcodé Ltd",
      "!!!",
      "x".repeat(120),
      "a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5",
    ]) {
      expect(slugify(name)).toMatch(ORG_SLUG);
    }
  });

  it("falls back rather than returning an empty slug", () => {
    expect(slugify("!!!")).toBe("org");
    expect(slugify("")).toBe("org");
  });

  // Truncation must not leave the hyphen it cut a word at as the last
  // character, which is exactly the shape the api refuses.
  it("does not end on a hyphen after truncation", () => {
    const long = slugify("a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5");
    expect(long.endsWith("-")).toBe(false);
    expect(long.length).toBeLessThanOrEqual(48);
  });
});

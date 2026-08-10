import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it } from "vitest";
import { PLANS } from "../billing/plans";
import { loadEnv } from "../config/env";
import { beforeCreateOrganization, ORG_ROLES } from "./organization";

// The environment is parsed once at boot, so a test that is about what a
// variable MEANS says when the process read it.
afterEach(() => {
  delete process.env.DEFAULT_ORG_PLAN;
  loadEnv("api");
});

function withPlan(value: string): void {
  process.env.DEFAULT_ORG_PLAN = value;
  loadEnv("api");
}

describe("beforeCreateOrganization", () => {
  // The test #132 was missing. `defaultOrgPlan()` had unit tests that passed
  // while the function reached nothing: they tested the reader, and nothing
  // tested that anything read it. This one fails if the hook stops asking.
  it("stamps the plan the deployment asked for", async () => {
    withPlan("SELF_HOSTED");
    const { data } = await beforeCreateOrganization({
      organization: { name: "Acme", slug: "acme" },
    });
    expect(data.plan).toBe("SELF_HOSTED");
  });

  // Every plan, not just the interesting one: a hook that hard-coded
  // SELF_HOSTED would pass the test above and be exactly as wrong as a hook
  // that hard-codes FREE.
  it.each(PLANS)("carries %s through rather than choosing for itself", async (plan) => {
    withPlan(plan);
    const { data } = await beforeCreateOrganization({
      organization: { name: "Acme", slug: "acme" },
    });
    expect(data.plan).toBe(plan);
  });

  // The default of the schema, not of the column. A deployment that says
  // nothing still gets the most restrictive plan — what changed is that the
  // answer now comes from a place that can be told otherwise.
  it("falls back to FREE when the deployment says nothing", async () => {
    const { data } = await beforeCreateOrganization({
      organization: { name: "Acme", slug: "acme" },
    });
    expect(data.plan).toBe("FREE");
  });

  it("passes the submitted fields through untouched", async () => {
    const { data } = await beforeCreateOrganization({
      organization: { name: "Acme", slug: "acme", logo: null },
    });
    expect(data).toMatchObject({ name: "Acme", slug: "acme", logo: null });
  });

  // The slug is validated rather than rewritten — the endpoint checks the
  // submitted one for a collision BEFORE this hook runs, so a hook that changed
  // it would be checking one string and inserting another.
  it.each(["Acme", "-acme", "acme-", "a c m e", "", "acme_corp"])(
    "refuses the slug %j",
    async (slug) => {
      await expect(
        beforeCreateOrganization({ organization: { name: "Acme", slug } }),
      ).rejects.toBeInstanceOf(APIError);
    },
  );

  it.each(["a", "acme", "acme-corp", "a1-2b3"])("accepts the slug %j", async (slug) => {
    const { data } = await beforeCreateOrganization({ organization: { name: "Acme", slug } });
    expect(data.slug).toBe(slug);
  });
});

describe("ORG_ROLES", () => {
  // The plugin's third default role, `admin`, is deliberately absent: half the
  // api asks the one question TenancyService.requireOwner asks.
  it("is owner and member and nothing else", () => {
    expect(ORG_ROLES).toEqual(["owner", "member"]);
  });
});

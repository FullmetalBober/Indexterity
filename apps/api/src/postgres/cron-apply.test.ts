import { describe, expect, it } from "vitest";
import {
  CRON_APPLY_FUNCTION,
  CRON_APPLY_SCHEMA,
  cronApplySetup,
  cronDirections,
  isUnrecognizedGuc,
  readCronApplyProbe,
} from "./cron-apply";

// The setup snippet is the whole security boundary of this route, and it is
// handed to an operator to paste. What matters is not that it reads well but
// that pasting it whole cannot produce a weaker installation than the one
// described (#332).
describe("cronApplySetup", () => {
  const snippet = cronApplySetup("appowner", "indexterity");

  it("creates the function as the table owner, not as whoever pastes it", () => {
    // Without SET ROLE a superuser pasting this owns the function, and every
    // build then runs as a superuser instead of as the table owner.
    expect(snippet).toContain('SET ROLE "appowner";');
    expect(snippet.indexOf('SET ROLE "appowner";')).toBeLessThan(
      snippet.indexOf("CREATE OR REPLACE FUNCTION"),
    );
    expect(snippet).toContain("RESET ROLE;");
  });

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(snippet).toContain("SECURITY DEFINER");
    expect(snippet).toContain("SET search_path = pg_catalog, pg_temp");
  });

  it("revokes from PUBLIC before granting, so EXECUTE is not world-readable", () => {
    const revoke = snippet.indexOf("REVOKE ALL ON FUNCTION");
    const grant = snippet.indexOf('GRANT EXECUTE ON FUNCTION "indexterity"."apply_index"');
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(snippet).toContain('TO "indexterity";');
  });

  it("quotes both role names, so a role needing quoting cannot break out", () => {
    const quoted = cronApplySetup('weird"owner', "scoped role");
    expect(quoted).toContain('SET ROLE "weird""owner";');
    expect(quoted).toContain('TO "scoped role";');
  });

  it("installs into its own schema rather than public", () => {
    // PostgreSQL 15 revoked CREATE on public from PUBLIC, and the table owner is
    // not a superuser — installing into public answers permission denied.
    expect(snippet).toContain(`CREATE SCHEMA IF NOT EXISTS "${CRON_APPLY_SCHEMA}"`);
    expect(snippet).not.toMatch(/FUNCTION "?public"?\./);
  });

  it("names the restart, because it is the one step that costs downtime", () => {
    expect(snippet).toContain("shared_preload_libraries = 'pg_cron'");
    expect(snippet.toLowerCase()).toContain("restart");
  });

  // The function takes identifiers as text[] and quotes each with %I; there is
  // no argument that accepts a SQL fragment. A partial predicate would be one,
  // which is why it is absent rather than passed through.
  it("takes no free-text SQL argument", () => {
    expect(snippet).toContain("columns         text[]");
    expect(snippet).toContain("directions      text[]");
    expect(snippet).not.toMatch(/\bpredicate\b|\bwhere_clause\b/i);
    expect(snippet).toContain("direction must be ASC or DESC");
  });
});

describe("readCronApplyProbe", () => {
  it("reports nothing installed when the function is absent", () => {
    expect(readCronApplyProbe([])).toEqual({ installed: false, executable: false, owner: null });
  });

  // A SECURITY INVOKER function would run as the scoped role, which cannot
  // create an index — present but useless, and better reported as absent than
  // discovered at the first apply.
  it("treats a non-SECURITY-DEFINER function as not installed", () => {
    const probe = readCronApplyProbe([
      { security_definer: false, executable: true, owner: "appowner" },
    ]);
    expect(probe.installed).toBe(false);
    expect(probe.owner).toBe("appowner");
  });

  it("separates installed from executable, so a missing GRANT is its own answer", () => {
    expect(
      readCronApplyProbe([{ security_definer: true, executable: false, owner: "appowner" }]),
    ).toEqual({ installed: true, executable: false, owner: "appowner" });
  });
});

describe("cronDirections", () => {
  it("maps the engine-neutral 1/-1 onto the function's whitelist", () => {
    expect(cronDirections({ sku: 1, qty: -1 })).toEqual(["ASC", "DESC"]);
  });
});

describe("isUnrecognizedGuc", () => {
  it("recognises the answer a server without pg_cron preloaded gives", () => {
    expect(
      isUnrecognizedGuc(new Error('unrecognized configuration parameter "cron.database_name"')),
    ).toBe(true);
    expect(isUnrecognizedGuc(new Error("permission denied for schema cron"))).toBe(false);
  });
});

it("exports the names the probe and the snippet must agree on", () => {
  expect(CRON_APPLY_SCHEMA).toBe("indexterity");
  expect(CRON_APPLY_FUNCTION).toBe("apply_index");
});

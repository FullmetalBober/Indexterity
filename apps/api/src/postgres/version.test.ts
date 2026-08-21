import { describe, expect, it } from "vitest";
import {
  PG_MAX_TESTED_MAJOR,
  PG_MIN_MAJOR,
  parsePostgresVersion,
  postgresHasLastIdxScan,
  postgresVersionRefusal,
} from "./version";

describe("parsePostgresVersion", () => {
  // The two readings a live server gives, verbatim from 14.24 and 16.15.
  it("prefers server_version_num, which needs no parsing", () => {
    expect(parsePostgresVersion("160015", "16.15 (Debian 16.15-1.pgdg13+2)")).toEqual({
      major: 16,
      minor: 15,
      text: "16.15 (Debian 16.15-1.pgdg13+2)",
    });
    expect(parsePostgresVersion(140024, "14.24 (Debian 14.24-1.pgdg13+2)")?.major).toBe(14);
  });

  // A packaging suffix is exactly what would confuse a text parser, so the
  // integer path has to be the one that wins.
  it("falls back to the text when the number is unusable", () => {
    expect(parsePostgresVersion(null, "18.6 (Debian 18.6-1.pgdg13+2)")).toEqual({
      major: 18,
      minor: 6,
      text: "18.6 (Debian 18.6-1.pgdg13+2)",
    });
    expect(parsePostgresVersion("not a number", "17.11")?.major).toBe(17);
  });

  // The pre-10 encoding is not decoded on purpose: 90624 would read as major 9
  // only if someone taught it the old scheme, and every such release is refused
  // by the floor anyway. What matters is that it does not produce a confidently
  // wrong answer that passes the gate.
  it("does not invent a major from a pre-10 version number", () => {
    const parsed = parsePostgresVersion("90624", "9.6.24");
    expect(parsed?.major).toBe(9);
    expect(postgresVersionRefusal(parsed)).toMatch(/older than the PostgreSQL 14 floor/);
  });

  it("answers null when there is nothing to read", () => {
    expect(parsePostgresVersion(null, null)).toBeNull();
    expect(parsePostgresVersion(undefined, "")).toBeNull();
    expect(parsePostgresVersion({}, "postgres")).toBeNull();
  });
});

describe("postgresVersionRefusal", () => {
  // Unreadable is unsupported, never "probably fine" — the same rule both other
  // engines apply, and it matters more here because the drop cannot be un-hidden.
  it("refuses a version it could not read", () => {
    expect(postgresVersionRefusal(null)).toMatch(/could not be read/);
  });

  it("refuses below the floor and accepts the floor itself", () => {
    expect(postgresVersionRefusal({ major: 13, minor: 22, text: "13.22" })).toMatch(
      /no security fixes/,
    );
    expect(postgresVersionRefusal({ major: PG_MIN_MAJOR, minor: 24, text: "14.24" })).toBeNull();
  });

  it("accepts every release between the floor and the tested ceiling", () => {
    for (let major = PG_MIN_MAJOR; major <= PG_MAX_TESTED_MAJOR; major += 1) {
      expect(postgresVersionRefusal({ major, minor: 0, text: `${major}.0` })).toBeNull();
    }
  });

  // A humility decision, not a support one: the message says what has moved
  // between releases before, so a reader can judge the risk themselves.
  it("refuses above the tested ceiling, and names the escape hatch", () => {
    const refusal = postgresVersionRefusal({
      major: PG_MAX_TESTED_MAJOR + 1,
      minor: 0,
      text: "19.0",
    });
    expect(refusal).toMatch(/newer than the PostgreSQL 18 series/);
    expect(refusal).toMatch(/ALLOW_UNTESTED_DATABASE_VERSION/);
  });

  it("lets the escape hatch through the ceiling but never the floor", () => {
    expect(
      postgresVersionRefusal({ major: PG_MAX_TESTED_MAJOR + 1, minor: 0, text: "19.0" }, true),
    ).toBeNull();
    // The floor is not overridable, which is the whole difference between the two.
    expect(postgresVersionRefusal({ major: 12, minor: 0, text: "12.0" }, true)).toMatch(
      /older than the PostgreSQL 14 floor/,
    );
  });
});

describe("postgresHasLastIdxScan", () => {
  // Measured: absent on 14.24, present on 16.15. Enrichment rather than a
  // requirement, which is why 14 and 15 are supported instead of refused.
  it("is true from 16 and false below it", () => {
    expect(postgresHasLastIdxScan({ major: 15, minor: 14, text: "15.14" })).toBe(false);
    expect(postgresHasLastIdxScan({ major: 16, minor: 15, text: "16.15" })).toBe(true);
    expect(postgresHasLastIdxScan({ major: 18, minor: 6, text: "18.6" })).toBe(true);
  });

  it("does not gate support on it", () => {
    for (const major of [14, 15]) {
      expect(postgresVersionRefusal({ major, minor: 0, text: `${major}.0` })).toBeNull();
      expect(postgresHasLastIdxScan({ major, minor: 0, text: `${major}.0` })).toBe(false);
    }
  });
});

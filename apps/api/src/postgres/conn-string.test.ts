import { describe, expect, it } from "vitest";
import { NO_TLS_OVERRIDES } from "../engine/ports";
import {
  applyPgTlsOverrides,
  assertPgTlsEnforced,
  isPgConnString,
  parsePgConnString,
  pgConnStringUsername,
  pgHosts,
  retargetPgConnString,
  sslModeOf,
  withPgCredentials,
} from "./conn-string";

const overrides = (partial: Partial<typeof NO_TLS_OVERRIDES>) => ({
  ...NO_TLS_OVERRIDES,
  ...partial,
});

describe("parsePgConnString", () => {
  it("reads the URI form whole", () => {
    const parsed = parsePgConnString(
      "postgresql://amy:s3cret@db.corp:5433/app?sslmode=verify-full",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.form).toBe("uri");
    expect(parsed?.hosts).toEqual([{ host: "db.corp", port: 5433 }]);
    expect(parsed?.database).toBe("app");
    expect(parsed?.user).toBe("amy");
    expect(parsed?.password).toBe("s3cret");
    expect(parsed?.params.get("sslmode")).toBe("verify-full");
  });

  it("takes the postgres:// spelling too", () => {
    expect(parsePgConnString("postgres://u@h/db")?.hosts).toEqual([{ host: "h", port: 5432 }]);
  });

  // libpq's HA form. WHATWG URL throws ERR_INVALID_URL on this (measured), which
  // is the whole reason this parser is hand-written: the network guard has to see
  // both hosts, and a throw here would refuse an ordinary string.
  it("sees every host of a multi-host string", () => {
    const parsed = parsePgConnString("postgresql://u:p@primary.corp:5432,standby.corp:5433/app");
    expect(parsed?.hosts).toEqual([
      { host: "primary.corp", port: 5432 },
      { host: "standby.corp", port: 5433 },
    ]);
    expect(pgHosts("postgresql://u:p@primary.corp:5432,standby.corp:5433/app")).toEqual({
      hosts: ["primary.corp:5432", "standby.corp:5433"],
      isSrv: false,
    });
  });

  it("defaults the port and never swallows a real one", () => {
    expect(parsePgConnString("postgresql://u@h/db")?.hosts[0]?.port).toBe(5432);
    // 443 survives, which is the bug a special-scheme URL parser would introduce.
    expect(parsePgConnString("postgresql://u@h:443/db")?.hosts[0]?.port).toBe(443);
  });

  it("keeps an IPv6 literal intact, with and without a port", () => {
    expect(parsePgConnString("postgresql://u@[2001:db8::1]:5433/db")?.hosts).toEqual([
      { host: "2001:db8::1", port: 5433 },
    ]);
    expect(parsePgConnString("postgresql://u@[::1]/db")?.hosts).toEqual([
      { host: "::1", port: 5432 },
    ]);
  });

  it("percent-decodes credentials", () => {
    const parsed = parsePgConnString("postgresql://a%40b:p%3As%2Fs@h/db");
    expect(parsed?.user).toBe("a@b");
    expect(parsed?.password).toBe("p:s/s");
  });

  it("reads the keyword form, quoting included", () => {
    const parsed = parsePgConnString(
      "host=db.corp port=5433 dbname=app user=amy password='two words' sslmode=require",
    );
    expect(parsed?.form).toBe("keyword");
    expect(parsed?.hosts).toEqual([{ host: "db.corp", port: 5433 }]);
    expect(parsed?.database).toBe("app");
    expect(parsed?.password).toBe("two words");
    expect(parsed?.params.get("sslmode")).toBe("require");
  });

  // libpq pairs the two lists positionally, and one port applies to every host.
  it("pairs a keyword host list with its port list", () => {
    expect(parsePgConnString("host=a,b port=5432,5433 dbname=d")?.hosts).toEqual([
      { host: "a", port: 5432 },
      { host: "b", port: 5433 },
    ]);
    expect(parsePgConnString("host=a,b port=6000 dbname=d")?.hosts).toEqual([
      { host: "a", port: 6000 },
      { host: "b", port: 6000 },
    ]);
  });

  // Both spellings of a unix socket. Refused rather than half-supported: there
  // is nothing for the network guard to vet and nothing TLS could protect.
  it("refuses a unix socket in either form", () => {
    expect(isPgConnString("postgresql:///app?host=/var/run/postgresql")).toBe(false);
    expect(isPgConnString("host=/var/run/postgresql dbname=app")).toBe(false);
  });

  it("refuses what it cannot dial", () => {
    for (const value of [
      "",
      "   ",
      "http://h/db",
      "postgresql://",
      `postgresql://u@${"x".repeat(5000)}/db`,
    ]) {
      expect(isPgConnString(value)).toBe(false);
    }
  });
});

// The guard has to be disjoint from the other adapters' or engine detection by
// elimination stops being unambiguous — this is the property registry.test.ts
// leans on for the whole set.
describe("isPgConnString disjointness", () => {
  it("never claims another engine's string", () => {
    for (const value of [
      "mongodb://u:p@h:27017/db",
      "mongodb+srv://u:p@cluster.example.net/db",
      "mssql://u:p@h:1433/db",
      "sqlserver://u:p@h:1433",
      "Server=h,1433;Database=d;User Id=u;Password=p",
      "Data Source=h;Initial Catalog=d",
    ]) {
      expect(isPgConnString(value)).toBe(false);
    }
  });

  // The keyword form is the sharp edge: it is anchored to host=/hostaddr=, so a
  // mongo string carrying host= in a query cannot claim it, and SQL Server's ADO
  // form leads with `server=`, which this never accepts.
  it("is not fooled by host= inside another engine's string", () => {
    expect(isPgConnString("mongodb://u:p@h:27017/?appName=host=1")).toBe(false);
    expect(isPgConnString("Server=h;Network Address=host=x")).toBe(false);
  });
});

describe("sslModeOf", () => {
  // libpq's own default, and the reason a pasted string cannot simply be
  // trusted: prefer falls back to plaintext without saying so.
  it("treats a string with no sslmode as prefer", () => {
    const parsed = parsePgConnString("postgresql://u@h/db");
    expect(parsed).not.toBeNull();
    if (parsed !== null) expect(sslModeOf(parsed)).toBe("prefer");
  });

  it("ignores a mode it does not recognise", () => {
    const parsed = parsePgConnString("postgresql://u@h/db?sslmode=banana");
    if (parsed !== null) expect(sslModeOf(parsed)).toBe("prefer");
  });
});

describe("assertPgTlsEnforced", () => {
  it("accepts verify-full with nothing ticked", () => {
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=verify-full", NO_TLS_OVERRIDES),
    ).not.toThrow();
  });

  // Each rung refused with nothing ticked, including the two that read as safe:
  // `require` encrypts and validates nothing, and a string naming no sslmode at
  // all is `prefer`, which may end up in plaintext.
  it("refuses every weaker rung when nothing is ticked", () => {
    for (const mode of ["disable", "allow", "prefer", "require", "verify-ca"]) {
      expect(() =>
        assertPgTlsEnforced(`postgresql://u@h/db?sslmode=${mode}`, NO_TLS_OVERRIDES),
      ).toThrow(new RegExp(`sslmode=${mode}`));
    }
    expect(() => assertPgTlsEnforced("postgresql://u@h/db", NO_TLS_OVERRIDES)).toThrow(/prefer/);
  });

  it("accepts exactly the rung each box consents to", () => {
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=verify-ca",
        overrides({ allowInvalidHostnames: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=require",
        overrides({ allowInvalidCertificates: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=disable", overrides({ insecure: true })),
    ).not.toThrow();
  });

  // Weakening only. A string stronger than the boxes allow is a decision to be
  // safer than required, and is left alone rather than argued with.
  it("does not object to a string stronger than the boxes", () => {
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=verify-full",
        overrides({ insecure: true, allowInvalidCertificates: true }),
      ),
    ).not.toThrow();
  });

  // The fix is a checkbox on the form the reader is already looking at, so the
  // message has to name it.
  it("names the box that would allow what it found", () => {
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=require", NO_TLS_OVERRIDES),
    ).toThrow(/allow invalid certificates/);
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=verify-ca", NO_TLS_OVERRIDES),
    ).toThrow(/allow invalid hostnames/);
  });
});

describe("applyPgTlsOverrides", () => {
  it("writes the mode the boxes mean, in the URI form", () => {
    expect(applyPgTlsOverrides("postgresql://u@h/db", NO_TLS_OVERRIDES)).toContain(
      "sslmode=verify-full",
    );
    expect(applyPgTlsOverrides("postgresql://u@h/db", overrides({ insecure: true }))).toContain(
      "sslmode=disable",
    );
    expect(
      applyPgTlsOverrides("postgresql://u@h/db", overrides({ allowInvalidCertificates: true })),
    ).toContain("sslmode=require");
  });

  // A second, contradicting copy of the option is the failure this guards: the
  // stored string must not carry both what was pasted and what was consented to.
  it("removes a casing variant rather than adding a second copy", () => {
    const applied = applyPgTlsOverrides("postgresql://u@h/db?SSLMode=disable", NO_TLS_OVERRIDES);
    expect(applied.toLowerCase().match(/sslmode=/g)).toHaveLength(1);
    expect(applied).toContain("sslmode=verify-full");
  });

  it("keeps every other parameter", () => {
    const applied = applyPgTlsOverrides(
      "postgresql://u@h/db?application_name=idx&connect_timeout=5",
      NO_TLS_OVERRIDES,
    );
    expect(applied).toContain("application_name=idx");
    expect(applied).toContain("connect_timeout=5");
  });

  it("leaves a stronger pasted mode alone", () => {
    expect(
      applyPgTlsOverrides(
        "postgresql://u@h/db?sslmode=verify-full",
        overrides({ allowInvalidCertificates: true }),
      ),
    ).toContain("sslmode=verify-full");
  });

  it("writes into the keyword form as a keyword", () => {
    const applied = applyPgTlsOverrides("host=h dbname=d user=u", NO_TLS_OVERRIDES);
    expect(applied).toContain("sslmode=verify-full");
    expect(applied).not.toContain("?");
    expect(parsePgConnString(applied)?.form).toBe("keyword");
  });

  // What apply writes, assert must accept — otherwise onboarding stores a string
  // the very next dial refuses.
  it("produces a string its own assert accepts", () => {
    for (const box of [
      NO_TLS_OVERRIDES,
      overrides({ insecure: true }),
      overrides({ allowInvalidCertificates: true }),
      overrides({ allowInvalidHostnames: true }),
    ]) {
      for (const pasted of [
        "postgresql://u:p@h:5432/db?sslmode=prefer",
        "host=h dbname=d user=u",
      ]) {
        const applied = applyPgTlsOverrides(pasted, box);
        expect(() => assertPgTlsEnforced(applied, box)).not.toThrow();
      }
    }
  });
});

describe("retargetPgConnString", () => {
  // A standby keeps its own idx_scan counters, so it is dialled directly — and a
  // multi-host string has to be narrowed to the one node being read, or libpq
  // picks for us.
  it("narrows a multi-host URI to the node being collected", () => {
    const retargeted = retargetPgConnString(
      "postgresql://u:p@primary.corp:5432,standby.corp:5433/app?sslmode=verify-full",
      "standby.corp",
      5433,
    );
    expect(pgHosts(retargeted).hosts).toEqual(["standby.corp:5433"]);
    expect(retargeted).toContain("sslmode=verify-full");
    expect(parsePgConnString(retargeted)?.database).toBe("app");
    expect(parsePgConnString(retargeted)?.password).toBe("p");
  });

  it("keeps the pasted form and every option in the keyword form", () => {
    const retargeted = retargetPgConnString(
      "host=primary.corp port=5432 dbname=app user=amy sslmode=verify-full",
      "standby.corp",
      5433,
    );
    const parsed = parsePgConnString(retargeted);
    expect(parsed?.form).toBe("keyword");
    expect(parsed?.hosts).toEqual([{ host: "standby.corp", port: 5433 }]);
    expect(parsed?.user).toBe("amy");
    expect(parsed?.params.get("sslmode")).toBe("verify-full");
  });

  it("brackets an IPv6 target so the port stays readable", () => {
    expect(pgHosts(retargetPgConnString("postgresql://u@h/db", "2001:db8::5", 5432)).hosts).toEqual(
      ["2001:db8::5:5432"],
    );
  });
});

describe("withPgCredentials", () => {
  // The admin string's transport choices survive into the string we store; the
  // admin string itself never is.
  it("swaps the credentials and keeps everything else, URI form", () => {
    const swapped = withPgCredentials(
      "postgresql://admin:letmein@db.corp:5433/app?sslmode=verify-full",
      "idx_reader",
      "p@ss w/ord",
    );
    const parsed = parsePgConnString(swapped);
    expect(parsed?.user).toBe("idx_reader");
    expect(parsed?.password).toBe("p@ss w/ord");
    expect(parsed?.hosts).toEqual([{ host: "db.corp", port: 5433 }]);
    expect(parsed?.database).toBe("app");
    expect(parsed?.params.get("sslmode")).toBe("verify-full");
  });

  it("survives a password needing the keyword form's own quoting", () => {
    const swapped = withPgCredentials("host=h dbname=d user=admin password=old", "idx", "a b'c\\d");
    const parsed = parsePgConnString(swapped);
    expect(parsed?.user).toBe("idx");
    expect(parsed?.password).toBe("a b'c\\d");
  });

  it("keeps a multi-host string multi-host", () => {
    const swapped = withPgCredentials("postgresql://a:b@h1:5432,h2:5433/d", "idx", "x");
    expect(pgHosts(swapped).hosts).toEqual(["h1:5432", "h2:5433"]);
  });
});

describe("pgConnStringUsername", () => {
  it("answers the user a string authenticates as, or null", () => {
    expect(pgConnStringUsername("postgresql://amy:p@h/db")).toBe("amy");
    expect(pgConnStringUsername("host=h dbname=d user=amy")).toBe("amy");
    // libpq falls back to the OS user, which is not something we can name.
    expect(pgConnStringUsername("postgresql://h/db")).toBeNull();
    expect(pgConnStringUsername("not a connection string")).toBeNull();
  });
});

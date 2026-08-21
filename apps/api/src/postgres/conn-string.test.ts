import { describe, expect, it } from "vitest";
import { NO_TLS_OVERRIDES } from "../engine/ports";
import {
  applyPgTlsOverrides,
  assertPgTlsEnforced,
  effectivePgTrust,
  isPgConnString,
  parsePgConnString,
  pgConnStringUsername,
  pgHosts,
  retargetPgConnString,
  sslModeOf,
  usesLibpqCompat,
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
  // NOT libpq's `prefer`. Measured on pg 8.22.0: with no sslmode the driver
  // connects in plaintext against a server offering TLS, so absence sits on the
  // floor rather than one rung above it.
  it("treats a string with no sslmode as disable, which is what the driver does", () => {
    const parsed = parsePgConnString("postgresql://u@h/db");
    expect(parsed).not.toBeNull();
    if (parsed !== null) expect(sslModeOf(parsed)).toBe("disable");
  });

  it("ignores a mode it does not recognise", () => {
    const parsed = parsePgConnString("postgresql://u@h/db?sslmode=banana");
    if (parsed !== null) expect(sslModeOf(parsed)).toBe("disable");
  });

  it("reads the compat opt-in", () => {
    const off = parsePgConnString("postgresql://u@h/db?sslmode=require");
    const on = parsePgConnString("postgresql://u@h/db?sslmode=require&uselibpqcompat=true");
    if (off !== null) expect(usesLibpqCompat(off)).toBe(false);
    if (on !== null) expect(usesLibpqCompat(on)).toBe(true);
  });
});

// The driver's reading of sslmode is not libpq's, and the whole safety of the
// checkbox mapping rests on which one this file believes. Every row here was
// measured against a live server with a self-signed certificate.
describe("effectivePgTrust", () => {
  it("scores a bare require as verify-full, because the driver aliases it", () => {
    const bare = parsePgConnString("postgresql://u@h/db?sslmode=require");
    const strict = parsePgConnString("postgresql://u@h/db?sslmode=verify-full");
    if (bare !== null && strict !== null) {
      expect(effectivePgTrust(bare)).toBe(effectivePgTrust(strict));
    }
  });

  it("only reaches the unchecked-certificate rung under the compat flag", () => {
    const compat = parsePgConnString("postgresql://u@h/db?sslmode=require&uselibpqcompat=true");
    const strict = parsePgConnString("postgresql://u@h/db?sslmode=verify-full");
    if (compat !== null && strict !== null) {
      expect(effectivePgTrust(compat)).toBeLessThan(effectivePgTrust(strict));
    }
  });

  it("puts plaintext and an absent sslmode on the same floor", () => {
    const off = parsePgConnString("postgresql://u@h/db?sslmode=disable");
    const absent = parsePgConnString("postgresql://u@h/db");
    if (off !== null && absent !== null) {
      expect(effectivePgTrust(absent)).toBe(effectivePgTrust(off));
    }
  });
});

describe("assertPgTlsEnforced", () => {
  it("accepts verify-full with nothing ticked", () => {
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=verify-full", NO_TLS_OVERRIDES),
    ).not.toThrow();
  });

  // Only the plaintext rungs are weaker on this driver, and a string naming NO
  // sslmode is one of them — measured, and the reason absence is not treated as
  // libpq's `prefer`.
  it("refuses plaintext, including a string that names no sslmode", () => {
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=disable", NO_TLS_OVERRIDES),
    ).toThrow(/gives away more/);
    expect(() => assertPgTlsEnforced("postgresql://u@h/db", NO_TLS_OVERRIDES)).toThrow(
      /gives away more/,
    );
  });

  // The counter-intuitive half, and the reason effectivePgTrust exists: a bare
  // `sslmode=require` is silently upgraded to verify-full by this driver, so it
  // concedes nothing and refusing it would refuse a safe string. It becomes a
  // concession only once `uselibpqcompat=true` is present.
  it("accepts a bare require, and refuses the same string under the compat flag", () => {
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=require", NO_TLS_OVERRIDES),
    ).not.toThrow();
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=require&uselibpqcompat=true",
        NO_TLS_OVERRIDES,
      ),
    ).toThrow(/gives away more/);
  });

  it("accepts the conceded rung once its box is ticked", () => {
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=require&uselibpqcompat=true",
        overrides({ allowInvalidCertificates: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertPgTlsEnforced("postgresql://u@h/db?sslmode=disable", overrides({ insecure: true })),
    ).not.toThrow();
  });

  // No usable rung exists for this one: the driver's verify-ca demands a CA file
  // and a connection string has nowhere to carry a PEM. Refused with the wider
  // box named, rather than quietly granting the wider concession.
  it("refuses the hostname box on its own, and says what to tick instead", () => {
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=verify-full",
        overrides({ allowInvalidHostnames: true }),
      ),
    ).toThrow(/cannot be honoured on PostgreSQL/);
    // Harmless once the wider box is ticked too — that is a concession already
    // made, not one inferred on the owner's behalf.
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=require&uselibpqcompat=true",
        overrides({ allowInvalidHostnames: true, allowInvalidCertificates: true }),
      ),
    ).not.toThrow();
  });

  // Weakening direction only. A string stronger than the boxes allow is a
  // decision to be safer than required, and is left alone rather than argued
  // with.
  it("does not object to a string stronger than the boxes", () => {
    expect(() =>
      assertPgTlsEnforced(
        "postgresql://u@h/db?sslmode=verify-full",
        overrides({ insecure: true, allowInvalidCertificates: true }),
      ),
    ).not.toThrow();
  });

  it("names the box that would allow the plaintext it found", () => {
    expect(() => assertPgTlsEnforced("postgresql://u@h/db", NO_TLS_OVERRIDES)).toThrow(
      /connect without TLS/,
    );
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
  // The hostname box is excluded on purpose: it has no representable rung here
  // and the assert refuses it outright, which the test above pins.
  it("produces a string its own assert accepts", () => {
    for (const box of [
      NO_TLS_OVERRIDES,
      overrides({ insecure: true }),
      overrides({ allowInvalidCertificates: true }),
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

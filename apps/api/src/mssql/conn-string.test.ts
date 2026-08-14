import { describe, expect, it } from "vitest";
import {
  applyMssqlTlsOverrides,
  encryptModeOf,
  isMssqlConnString,
  mssqlHosts,
  parseMssqlConnString,
  trustsServerCertificate,
} from "./conn-string";

const NONE = { allowInvalidCertificates: false, allowInvalidHostnames: false, insecure: false };

describe("isMssqlConnString", () => {
  it("accepts mssql:// and sqlserver:// URLs", () => {
    expect(isMssqlConnString("mssql://sa:pass@localhost:1433/master")).toBe(true);
    expect(isMssqlConnString("sqlserver://db.example.com/app")).toBe(true);
  });

  it("accepts ADO strings in their common spellings", () => {
    expect(isMssqlConnString("Server=localhost,1433;Database=app;User Id=sa;Password=p")).toBe(
      true,
    );
    expect(
      isMssqlConnString("Data Source=tcp:db.example.com,1433;Initial Catalog=app;UID=u;PWD=p"),
    ).toBe(true);
  });

  it("rejects other schemes (SSRF) and mongo strings (engine detection)", () => {
    expect(isMssqlConnString("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isMssqlConnString("file:///etc/passwd")).toBe(false);
    expect(isMssqlConnString("mongodb://localhost:27017")).toBe(false);
    expect(isMssqlConnString("mongodb+srv://cluster0.example.net/app")).toBe(false);
    expect(isMssqlConnString("postgres://localhost:5432/db")).toBe(false);
  });

  it("rejects garbage, empty and oversized", () => {
    expect(isMssqlConnString("")).toBe(false);
    expect(isMssqlConnString("not a url")).toBe(false);
    expect(isMssqlConnString(`mssql://${"a".repeat(5000)}`)).toBe(false);
  });
});

describe("parseMssqlConnString", () => {
  it("keeps an explicit port, including 443", () => {
    // A special-scheme parser would swallow :443 as a default port; the
    // non-special mssql: scheme must not.
    expect(parseMssqlConnString("mssql://u:p@host:443/db")?.port).toBe(443);
    expect(parseMssqlConnString("mssql://u:p@host/db")?.port).toBe(1433);
  });

  it("decodes URL-encoded credentials", () => {
    const parsed = parseMssqlConnString("mssql://sa:P%40ss%3Aword@host/db");
    expect(parsed?.user).toBe("sa");
    expect(parsed?.password).toBe("P@ss:word");
  });

  it("reads ADO server variants and quoted values", () => {
    const parsed = parseMssqlConnString(
      "Server=tcp:db.example.com,14330;Database=app;User Id=svc;Password={p;w=d}",
    );
    expect(parsed?.host).toBe("db.example.com");
    expect(parsed?.port).toBe(14330);
    expect(parsed?.password).toBe("p;w=d");
  });
});

describe("mssqlHosts", () => {
  it("names the one host:port for the network guard", () => {
    expect(mssqlHosts("mssql://u:p@db.internal:1433/x")).toEqual({
      hosts: ["db.internal:1433"],
      isSrv: false,
    });
    expect(mssqlHosts("Server=10.0.0.5;User Id=u;Password=p")).toEqual({
      hosts: ["10.0.0.5:1433"],
      isSrv: false,
    });
    expect(mssqlHosts("nonsense")).toEqual({ hosts: [], isSrv: false });
  });
});

describe("encrypt semantics", () => {
  it("defaults encryption ON when the string says nothing", () => {
    const parsed = parseMssqlConnString("mssql://u:p@host/db");
    expect(parsed && encryptModeOf(parsed)).toBe("on");
  });

  it("reads the 18.x vocabulary", () => {
    const of = (value: string) => {
      const parsed = parseMssqlConnString(`mssql://u:p@host/db?encrypt=${value}`);
      return parsed && encryptModeOf(parsed);
    };
    expect(of("strict")).toBe("strict");
    expect(of("mandatory")).toBe("on");
    expect(of("optional")).toBe("off");
    expect(of("false")).toBe("off");
    expect(of("no")).toBe("off");
  });
});

describe("applyMssqlTlsOverrides", () => {
  it("writes the ticked boxes into the string", () => {
    const out = applyMssqlTlsOverrides("mssql://u:p@host/db", {
      ...NONE,
      insecure: true,
      allowInvalidCertificates: true,
    });
    const parsed = parseMssqlConnString(out);
    expect(parsed && encryptModeOf(parsed)).toBe("off");
    expect(parsed && trustsServerCertificate(parsed)).toBe(true);
  });

  it("removes a pasted concession the boxes do not consent to", () => {
    const out = applyMssqlTlsOverrides(
      "Server=host;User Id=u;Password=p;Encrypt=false;TrustServerCertificate=true",
      NONE,
    );
    const parsed = parseMssqlConnString(out);
    expect(parsed && encryptModeOf(parsed)).toBe("on");
    expect(parsed && trustsServerCertificate(parsed)).toBe(false);
  });

  it("leaves a strengthening encrypt=strict alone", () => {
    const out = applyMssqlTlsOverrides("mssql://u:p@host/db?encrypt=strict", NONE);
    const parsed = parseMssqlConnString(out);
    expect(parsed && encryptModeOf(parsed)).toBe("strict");
  });

  it("round-trips the form the owner pasted", () => {
    const url = applyMssqlTlsOverrides("mssql://u:p@host:443/db", {
      ...NONE,
      allowInvalidCertificates: true,
    });
    expect(url.startsWith("mssql://")).toBe(true);
    expect(url).toContain(":443");
    const ado = applyMssqlTlsOverrides("Server=host;User Id=u;Password=p", {
      ...NONE,
      allowInvalidCertificates: true,
    });
    expect(ado).toContain("Server=host");
    expect(ado.toLowerCase()).toContain("trustservercertificate=true");
  });
});

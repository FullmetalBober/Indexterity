import { describe, expect, it } from "vitest";
import { directConnectionTo, isMongoConnString } from "./conn-string";

describe("isMongoConnString", () => {
  it("accepts mongodb and mongodb+srv", () => {
    expect(isMongoConnString("mongodb://localhost:27017")).toBe(true);
    expect(isMongoConnString("mongodb://user:pass@host1,host2:27018/db?replicaSet=rs")).toBe(true);
    expect(isMongoConnString("mongodb+srv://cluster0.example.mongodb.net/app")).toBe(true);
  });

  it("accepts a bare multi-host replica-set string", () => {
    // WHATWG `new URL` throws on this shape, so the old implementation
    // rejected every credential-less replica-set string.
    expect(isMongoConnString("mongodb://10.0.0.1:27017,10.0.0.2:27017")).toBe(true);
    expect(isMongoConnString("mongodb://a:27017,b:27017,c:27017/?replicaSet=rs0")).toBe(true);
  });
  it("rejects other schemes (SSRF)", () => {
    expect(isMongoConnString("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isMongoConnString("file:///etc/passwd")).toBe(false);
    expect(isMongoConnString("postgres://localhost:5432/db")).toBe(false);
    expect(isMongoConnString("gopher://internal:70")).toBe(false);
  });
  it("rejects garbage, empty and oversized", () => {
    expect(isMongoConnString("")).toBe(false);
    expect(isMongoConnString("not a url")).toBe(false);
    expect(isMongoConnString(`mongodb://${"a".repeat(5000)}`)).toBe(false);
  });
});

describe("directConnectionTo", () => {
  it("retargets a replica-set string at one member", () => {
    const out = directConnectionTo(
      "mongodb://u:p@a:27017,b:27017,c:27017/?replicaSet=rs0&tls=true",
      "b:27017",
    );
    expect(out).toContain("b:27017");
    expect(out).not.toContain("a:27017");
    expect(out).not.toContain("c:27017");
    expect(out).toContain("directConnection=true");
    // replicaSet contradicts directConnection; tls must survive.
    expect(out).not.toContain("replicaSet");
    expect(out).toContain("tls=true");
    // Credentials are carried over — the member needs the same auth.
    expect(out).toContain("u:p@");
  });

  it("converts an SRV seed to a plain string, since SRV cannot name a port", () => {
    const out = directConnectionTo(
      "mongodb+srv://u:p@cluster.example.net/?tls=true",
      "shard0:27017",
    );
    expect(out.startsWith("mongodb://")).toBe(true);
    expect(out).toContain("shard0:27017");
    expect(out).toContain("directConnection=true");
  });

  it("drops readPreference — a direct connection has one node to choose", () => {
    const out = directConnectionTo("mongodb://a:27017/?readPreference=secondary", "a:27017");
    expect(out).not.toContain("readPreference");
  });
});

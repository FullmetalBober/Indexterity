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

// Rewriting `mongodb+srv://` to `mongodb://` silently discards the two things an
// SRV string keeps outside its own text: tls (defaulted true by the scheme) and
// authSource (published in a DNS TXT record). Every per-member connection to an
// Atlas cluster therefore failed — at the handshake, then at auth — and the catch
// in members.ts hid it. Measured against a requireTLS + --auth mongod: as-built
// refused, +tls said "Authentication failed", +tls +authSource connected.
describe("directConnectionTo carrying resolved SRV options", () => {
  const ATLAS = "mongodb+srv://idx_ab12:pw@msb-db.hwrel.mongodb.net/msb-app?retryWrites=true";
  const MEMBER = "msb-db-shard-00-02.hwrel.mongodb.net:27017";
  const RESOLVED = { tls: true, authSource: "admin" };

  it("carries tls and authSource onto the plain string", () => {
    const out = directConnectionTo(ATLAS, MEMBER, RESOLVED);
    expect(out.startsWith("mongodb://")).toBe(true);
    expect(out).toContain("tls=true");
    expect(out).toContain("authSource=admin");
    // Everything the old conversion already got right stays right.
    expect(out).toContain(MEMBER);
    expect(out).toContain("directConnection=true");
    expect(out).toContain("idx_ab12:pw@");
    expect(out).toContain("retryWrites=true");
  });

  // The bug, stated as the absence it was: no third argument, no tls, no auth.
  it("is unchanged when nothing resolved is offered", () => {
    const out = directConnectionTo(ATLAS, MEMBER);
    expect(out).not.toContain("tls=");
    expect(out).not.toContain("authSource=");
  });

  // The string is the customer's statement and the resolution agrees with it, so
  // there is nothing to add — and overwriting would be us disagreeing with them.
  it("does not overrule an explicit tls, ssl or authSource", () => {
    expect(directConnectionTo(`${ATLAS}&tls=false`, MEMBER, RESOLVED)).toContain("tls=false");
    // `ssl` is the driver's alias for `tls`; setting tls beside it would leave
    // the string self-contradictory.
    const ssl = directConnectionTo(`${ATLAS}&ssl=false`, MEMBER, RESOLVED);
    expect(ssl).toContain("ssl=false");
    expect(ssl).not.toContain("tls=");
    expect(directConnectionTo(`${ATLAS}&authSource=other`, MEMBER, RESOLVED)).toContain(
      "authSource=other",
    );
  });

  it("adds no authSource for a cluster that takes no credentials", () => {
    const out = directConnectionTo("mongodb+srv://msb-db.hwrel.mongodb.net/msb-app", MEMBER, {
      tls: true,
      authSource: null,
    });
    expect(out).toContain("tls=true");
    expect(out).not.toContain("authSource");
  });

  // A plain string never lost anything: its options are in its own text, and the
  // conversion copies them across. Adding defaults there would change behaviour
  // for the clusters that were already working.
  it("leaves a non-SRV string alone", () => {
    const out = directConnectionTo("mongodb://u:p@a:27017,b:27017/db?replicaSet=rs0", "b:27017", {
      tls: true,
      authSource: "admin",
    });
    expect(out).not.toContain("tls=");
    expect(out).not.toContain("authSource=");
  });
});

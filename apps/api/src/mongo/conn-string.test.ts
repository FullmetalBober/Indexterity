import { describe, expect, it } from "vitest";
import { isMongoConnString } from "./conn-string";

describe("isMongoConnString", () => {
  it("accepts mongodb and mongodb+srv", () => {
    expect(isMongoConnString("mongodb://localhost:27017")).toBe(true);
    expect(isMongoConnString("mongodb://user:pass@host1,host2:27018/db?replicaSet=rs")).toBe(true);
    expect(isMongoConnString("mongodb+srv://cluster0.example.mongodb.net/app")).toBe(true);
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

import { describe, expect, it } from "vitest";
import { classifyClient, isWorthIndexing } from "./client";

describe("classifyClient", () => {
  it("recognises the shells and GUIs a person drives", () => {
    // Exactly what mongosh reports, from a live probe.
    expect(classifyClient({ application: "mongosh 2.8.3", driver: "nodejs|mongosh" })).toBe(
      "INTERACTIVE",
    );
    expect(classifyClient({ application: "MongoDB Compass 1.42.0" })).toBe("INTERACTIVE");
    expect(classifyClient({ application: "Studio 3T" })).toBe("INTERACTIVE");
    expect(classifyClient({ driver: "DataGrip 2026.1" })).toBe("INTERACTIVE");
  });

  it("treats an ordinary driver as application traffic", () => {
    expect(classifyClient({ application: "checkout-api", driver: "nodejs" })).toBe("APPLICATION");
    expect(classifyClient({ driver: "mongo-go-driver" })).toBe("APPLICATION");
    expect(classifyClient({ driver: "PyMongo" })).toBe("APPLICATION");
  });

  it("is UNKNOWN when the source names nobody", () => {
    expect(classifyClient({})).toBe("UNKNOWN");
  });
});

describe("isWorthIndexing", () => {
  it("declines a shape only ever run from a shell", () => {
    expect(
      isWorthIndexing([
        { application: "mongosh 2.8.3", driver: "nodejs|mongosh" },
        { application: "MongoDB Compass 1.42.0" },
      ]),
    ).toBe(false);
  });

  it("accepts as soon as one real client runs it", () => {
    // A developer explored it, then it shipped. The app is what matters.
    expect(
      isWorthIndexing([
        { application: "mongosh 2.8.3" },
        { application: "checkout-api", driver: "nodejs" },
      ]),
    ).toBe(true);
  });

  // A client that never set an app name is not evidence of a person at a
  // prompt. Refusing on missing evidence would quietly switch workload analysis
  // off for every driver that does not identify itself.
  it("does not withhold an index just because nobody was named", () => {
    expect(isWorthIndexing([])).toBe(true);
    expect(isWorthIndexing([{}])).toBe(true);
  });
});

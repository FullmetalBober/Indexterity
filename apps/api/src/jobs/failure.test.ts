import { describe, expect, it } from "vitest";
import { finalClusterFailure } from "./failure";

const base = {
  taskIdentifier: "collect",
  attempts: 5,
  maxAttempts: 5,
  payload: { clusterId: "c1" },
};

describe("finalClusterFailure", () => {
  it("alerts when the last retry of a cluster task burns", () => {
    expect(finalClusterFailure(base)).toBe("c1");
  });
  it("stays silent while retries remain", () => {
    expect(finalClusterFailure({ ...base, attempts: 3 })).toBeNull();
  });
  it("ignores non-cluster tasks and bad payloads", () => {
    expect(finalClusterFailure({ ...base, taskIdentifier: "retention" })).toBeNull();
    expect(finalClusterFailure({ ...base, payload: {} })).toBeNull();
  });
});

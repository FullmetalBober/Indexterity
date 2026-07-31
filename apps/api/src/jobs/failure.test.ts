import { describe, expect, it } from "vitest";
import { alertAllowed, resetAlertCooldowns } from "../mail/notify";
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

describe("alert cooldown", () => {
  it("allows the first alert per key, then suppresses within the window", () => {
    resetAlertCooldowns();
    const hour = 3_600_000;
    const t0 = 1_000_000;
    expect(alertAllowed("cluster-a:collect", 24 * hour, t0)).toBe(true);
    // Six hours later the next collect fails again — same cluster, same task.
    expect(alertAllowed("cluster-a:collect", 24 * hour, t0 + 6 * hour)).toBe(false);
    expect(alertAllowed("cluster-a:collect", 24 * hour, t0 + 18 * hour)).toBe(false);
    // A different cluster is not suppressed by a noisy neighbour.
    expect(alertAllowed("cluster-b:collect", 24 * hour, t0 + hour)).toBe(true);
    // Past the window it alerts again — a still-broken cluster is worth a
    // daily reminder.
    expect(alertAllowed("cluster-a:collect", 24 * hour, t0 + 25 * hour)).toBe(true);
  });
});

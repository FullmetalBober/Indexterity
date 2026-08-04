import { beforeEach, describe, expect, it } from "vitest";
import {
  observeClusterFleet,
  recordClusterTask,
  resetUnreachableClusters,
  unreachableClusterCount,
} from "./jobs";

const ONE = "11111111-1111-1111-1111-111111111111";
const TWO = "22222222-2222-2222-2222-222222222222";

// "How many clusters are unreachable right now" is the question this answers, and
// the only place it is answered: an unreachable tick is a handled condition that
// never reaches the queue as a failure, so no job counter sees it.
describe("the unreachable-cluster gauge", () => {
  beforeEach(() => {
    resetUnreachableClusters();
  });

  it("counts clusters, not ticks", () => {
    for (let i = 0; i < 5; i++) recordClusterTask("collect", ONE, "unreachable");
    expect(unreachableClusterCount()).toBe(1);
    recordClusterTask("collect", TWO, "unreachable");
    expect(unreachableClusterCount()).toBe(2);
  });

  it("clears a cluster that answers again", () => {
    recordClusterTask("collect", ONE, "unreachable");
    recordClusterTask("collect", ONE, "ok");
    expect(unreachableClusterCount()).toBe(0);
  });

  // The version check needs a live connection to fail, so an unsupported server
  // is a cluster we reached. Reporting it as unreachable would send an operator
  // after the network instead of after the upgrade.
  it("clears a cluster that answered with a version we cannot use", () => {
    recordClusterTask("apply", ONE, "unreachable");
    recordClusterTask("apply", ONE, "unsupported");
    expect(unreachableClusterCount()).toBe(0);
  });

  // Neither says anything about the network: the credential never decrypted, so
  // nothing was dialled, and an unexpected error is unexplained by definition.
  // Both leave the last real verdict standing rather than inventing a new one.
  it("leaves the verdict alone for undecryptable credentials and unexpected errors", () => {
    recordClusterTask("apply", ONE, "unreachable");
    recordClusterTask("apply", ONE, "credentials");
    expect(unreachableClusterCount()).toBe(1);
    recordClusterTask("apply", ONE, "error");
    expect(unreachableClusterCount()).toBe(1);
  });

  it("forgets a cluster that was offboarded while unreachable", () => {
    recordClusterTask("collect", ONE, "unreachable");
    recordClusterTask("collect", TWO, "unreachable");
    // The next dispatch fans out to what is left.
    observeClusterFleet([TWO]);
    expect(unreachableClusterCount()).toBe(1);
    observeClusterFleet([]);
    expect(unreachableClusterCount()).toBe(0);
  });

  // Offboarded between dispatch and run: the tick still happens and reports it.
  it("forgets a cluster that was deleted mid-tick", () => {
    recordClusterTask("collect", ONE, "unreachable");
    recordClusterTask("collect", ONE, "gone");
    expect(unreachableClusterCount()).toBe(0);
  });
});

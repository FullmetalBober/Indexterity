import { describe, expect, it } from "vitest";
import { privilegeNoticeText } from "./digest";

const PROFILER = {
  revision: 1,
  release: "0.29.0",
  key: "enableProfiler",
  label: "Turn the profiler on",
  enables: "the failed-operations check on clusters whose profiler is off",
};

// The one-time mail about privileges a release added (#599).
describe("privilegeNoticeText", () => {
  // The reader's first question is whether something broke. It did not.
  it("says nothing has stopped working, and what each privilege turns on", () => {
    const text = privilegeNoticeText([PROFILER], null, false);
    expect(text).toContain("Nothing has stopped working");
    expect(text).toContain(`enableProfiler (new in 0.29.0) — ${PROFILER.enables}`);
  });

  it("hands over the statement and the upgrade where the role is ours", () => {
    const text = privilegeNoticeText([PROFILER], "db.getSiblingDB(...)", true);
    expect(text).toContain("  db.getSiblingDB(...)");
    expect(text).toContain("upgrade the role from the cluster's Settings page");
  });

  // #246: no statement for a role somebody made by hand.
  it("points at the guide where the role was made by hand", () => {
    const text = privilegeNoticeText([PROFILER], null, false);
    expect(text).toContain("Add them to the role you created for Indexterity");
    expect(text).not.toContain("grantPrivilegesToRole");
  });
});

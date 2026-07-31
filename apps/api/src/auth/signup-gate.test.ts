import { describe, expect, it } from "vitest";
import { decideSignup } from "./signup-gate";

const stranger = { isFirstUser: false, hasPendingInvite: false };
const invited = { isFirstUser: false, hasPendingInvite: true };
const first = { isFirstUser: true, hasPendingInvite: false };

describe("decideSignup", () => {
  it("open mode lets anyone in", () => {
    for (const facts of [stranger, invited, first]) {
      expect(decideSignup("open", facts).allowed).toBe(true);
    }
  });

  it("invite mode admits the first user so the install can be bootstrapped", () => {
    expect(decideSignup("invite", first).allowed).toBe(true);
  });

  it("invite mode admits an invited address and refuses a stranger", () => {
    expect(decideSignup("invite", invited).allowed).toBe(true);
    const denied = decideSignup("invite", stranger);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("invite-only");
  });

  it("closed mode refuses everyone, including the first user", () => {
    expect(decideSignup("closed", first).allowed).toBe(false);
    expect(decideSignup("closed", invited).allowed).toBe(false);
    expect(decideSignup("closed", stranger).reason).toContain("disabled");
  });
});

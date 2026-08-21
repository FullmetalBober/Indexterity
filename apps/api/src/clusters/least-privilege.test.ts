import { describe, expect, it } from "vitest";
import { leastPrivilegeRefusal } from "./least-privilege";

// The refusal wording is the whole remedy a refused reader gets, so it is pinned
// rather than merely asserted to be non-null: "not allowed" and "let Indexterity
// provision one from this string instead" are the same verdict and two different
// screens' worth of usefulness.
describe("leastPrivilegeRefusal", () => {
  it("passes credentials that cannot create users", () => {
    expect(leastPrivilegeRefusal({ canProvision: false, authEnabled: true })).toBeNull();
  });

  it("refuses credentials that can create users, and points at provisioning", () => {
    const refusal = leastPrivilegeRefusal({ canProvision: true, authEnabled: true });
    expect(refusal).toContain("can create users or roles");
    // The path that DOES work has to be named, because it is one button along on
    // the screen this refusal lands on.
    expect(refusal).toContain("provision a scoped user");
    expect(refusal).toContain("never stored");
  });

  it("refuses a deployment with authentication off, and does not offer provisioning", () => {
    // The decision the issue left open: a server that asks for no credentials
    // holds every privilege and cannot be narrowed by any grant, so this is a
    // refusal rather than an exemption — and provisioning is not the answer,
    // because there is nothing to authenticate a scoped user as.
    const refusal = leastPrivilegeRefusal({ canProvision: false, authEnabled: false });
    expect(refusal).toContain("authentication disabled");
    expect(refusal).toContain("Enable authentication");
    expect(refusal).not.toContain("provision");
  });

  it("names the deployment rather than the grant when both are true", () => {
    // A no-auth server also reports canProvision in some shapes. The broader
    // finding wins: telling somebody to paste a narrower string at a server that
    // ignores credentials entirely is advice that cannot work.
    const refusal = leastPrivilegeRefusal({ canProvision: true, authEnabled: false });
    expect(refusal).toContain("authentication disabled");
  });
});

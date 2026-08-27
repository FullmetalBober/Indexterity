import type { SecurityEvent } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { eventLabel, eventLine, isUnprovenActor } from "./security-event";

function event(over: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    event: "SIGN_IN",
    actorUserId: "u1",
    actorEmail: "ana@example.com",
    target: null,
    clusterId: null,
    metadata: null,
    ipAddress: "203.0.113.7",
    userAgent: "Firefox",
    createdAt: "2026-08-11T09:00:00.000Z",
    ...over,
  };
}

describe("eventLine", () => {
  it("reads an ordinary act as who did it", () => {
    const line = eventLine(event({ event: "SIGN_IN" }));
    expect(line).toMatchObject({ label: "Signed in", actor: "ana@example.com", tone: "neutral" });
  });

  // The rule the whole screen turns on. SIGN_IN_FAILED records the typed address
  // as the TARGET and leaves the actor null, because nobody proved they were
  // that person — so drawing it as an actor accuses the account holder, who in
  // the row worth reading is the victim of it.
  it("gives a failed sign-in no actor and words the address as an attempt", () => {
    const line = eventLine(
      event({
        event: "SIGN_IN_FAILED",
        actorUserId: null,
        actorEmail: null,
        target: "ana@example.com",
      }),
    );
    expect(line.actor).toBeNull();
    expect(line.subject).toBe("attempted as ana@example.com");
    expect(line.tone).toBe("attempt");
  });

  it("applies the same rule to a failed second factor", () => {
    expect(isUnprovenActor("TWO_FACTOR_FAILED")).toBe(true);
    expect(eventLine(event({ event: "TWO_FACTOR_FAILED", target: "ana@example.com" })).actor).toBe(
      null,
    );
  });

  it("does not apply it to a successful sign-in", () => {
    expect(isUnprovenActor("SIGN_IN")).toBe(false);
  });

  // The acts an incident is read to find. Not "bad" — an owner disconnecting a
  // cluster is ordinary work — but they are the rows worth spotting in a page of
  // a hundred.
  it("marks the acts that take something away", () => {
    for (const name of ["TWO_FACTOR_DISABLED", "MEMBER_REMOVED", "CLUSTER_DISCONNECTED"]) {
      expect(eventLine(event({ event: name })).tone).toBe("severe");
    }
  });

  it("words a mode change from its metadata rather than from the act alone", () => {
    const live = eventLine(
      event({ event: "CLUSTER_MODE_CHANGED", target: "prod", metadata: { readOnly: false } }),
    );
    expect(live.subject).toBe("prod to live");
    const readOnly = eventLine(
      event({ event: "CLUSTER_MODE_CHANGED", target: "prod", metadata: { readOnly: true } }),
    );
    expect(readOnly.subject).toBe("prod back to read-only");
  });

  it("names the role on a promotion and on an invitation", () => {
    expect(
      eventLine(
        event({
          event: "MEMBER_ROLE_CHANGED",
          target: "bo@example.com",
          metadata: { role: "owner" },
        }),
      ).subject,
    ).toBe("bo@example.com as owner");
  });

  it("says which revoke happened", () => {
    expect(
      eventLine(event({ event: "SESSION_REVOKED", metadata: { scope: "others" } })).subject,
    ).toBe("all other sessions");
  });

  // The column is text so that adding an act is a constant rather than a
  // migration, so a row this build has no label for still has to render.
  it("falls back to the stored name for an act it does not know", () => {
    expect(eventLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(eventLine(event({ event: "SOMETHING_NEW" })).label).toBe("SOMETHING_NEW");
  });

  it("leaves the subject empty rather than inventing one", () => {
    expect(eventLine(event({ event: "SIGN_OUT", target: null })).subject).toBeNull();
  });
});

describe("a VPN tunnel act", () => {
  it("says which of the two edits a change was, and marks a replaced config", () => {
    const line = eventLine(
      event({
        event: "TUNNEL_UPDATED",
        target: "Production VPC",
        metadata: {
          tunnelId: "t1",
          name: null,
          config: {
            from: { endpoint: "vpn.old.example:51820", allowedIps: ["10.0.0.0/8"], dns: [] },
            to: { endpoint: "vpn.new.example:51820", allowedIps: ["10.0.0.0/8"], dns: [] },
          },
        },
      }),
    );
    // Severe for the reason a rotated credential is: a new PrivateKey, on
    // somebody's private network, and possibly a different network.
    expect(line).toMatchObject({ label: "VPN tunnel changed", tone: "severe" });
    expect(line.subject).toBe("Production VPC config replaced");
  });

  it("names the gateway a registration opened", () => {
    const line = eventLine(
      event({
        event: "TUNNEL_REGISTERED",
        target: "Production VPC",
        metadata: {
          tunnelId: "t1",
          endpoint: "vpn.example.com:51820",
          allowedIps: ["10.0.0.0/8"],
          dns: ["10.9.0.1"],
        },
      }),
    );
    expect(line).toMatchObject({ label: "VPN tunnel registered", tone: "neutral" });
    expect(line.subject).toBe("Production VPC gateway vpn.example.com:51820");
  });
});

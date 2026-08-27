import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { probeReachability } from "./reach";
import type { DeviceState, TunnelDevice } from "./wireguard/device";

// A device stands in for the protocol here. What is worth pinning is not the
// handshake — crypto.test.ts and conf.test.ts own that — but the four answers
// this probe is allowed to give, because each one is a sentence the dashboard
// puts in front of an owner: it answered, it stayed silent, it refused for a
// named reason, and "it is already up" is not one of them.

class FakeDevice extends EventEmitter {
  state: DeviceState = "down";
  age: number | null = null;
  asked = 0;
  #onAsk: (device: FakeDevice) => void;

  constructor(onAsk: (device: FakeDevice) => void) {
    super();
    this.#onAsk = onAsk;
  }

  handshakeAgeSeconds(): number | null {
    return this.age;
  }

  async handshake(): Promise<void> {
    this.asked += 1;
    this.#onAsk(this);
  }

  complete(): void {
    this.state = "up";
    this.age = 0;
    this.emit("handshake");
  }
}

function device(onAsk: (device: FakeDevice) => void): {
  fake: FakeDevice;
  as: TunnelDevice;
} {
  const fake = new FakeDevice(onAsk);
  return { fake, as: fake as unknown as TunnelDevice };
}

describe("probing whether a gateway answers", () => {
  it("reports reachable when a handshake completes", async () => {
    const { fake, as } = device((d) => d.complete());

    const result = await probeReachability(as, 50);

    expect(result).toEqual({
      reachable: true,
      state: "up",
      handshakeAgeSeconds: 0,
      error: null,
    });
    expect(fake.asked).toBe(1);
  });

  it("reports silence as unreachable without inventing a cause", async () => {
    const { as } = device(() => {
      // The gateway is off, or the port is dropped, or the PublicKey is wrong.
      // All three look exactly like this.
    });

    const result = await probeReachability(as, 20);

    expect(result.reachable).toBe(false);
    expect(result.error).toBeNull();
    // Whatever the device thought before the probe is what it still thinks: the
    // probe reports, it does not decide the tunnel is down.
    expect(result.state).toBe("down");
    expect(result.handshakeAgeSeconds).toBeNull();
  });

  it("names the device's own refusal when there is one", async () => {
    const { as } = device((d) => {
      d.emit("error", new Error("vpn.example.com resolves to a private address"));
    });

    const result = await probeReachability(as, 20);

    expect(result.reachable).toBe(false);
    expect(result.error).toBe("vpn.example.com resolves to a private address");
  });

  it("keeps quiet about an error the handshake then recovered from", async () => {
    const { as } = device((d) => {
      // A retried datagram, a response for a session already replaced: not
      // worth reporting once the peer has answered.
      d.emit("error", new Error("handshake response mac1 does not verify"));
      d.complete();
    });

    const result = await probeReachability(as, 50);

    expect(result.reachable).toBe(true);
    expect(result.error).toBeNull();
  });

  it("forces a handshake on a tunnel that is already up", async () => {
    // The case the test exists for: a session negotiated an hour ago, against a
    // gateway that has been switched off since. Reading the state would say UP.
    const { fake, as } = device(() => {});
    fake.state = "up";
    fake.age = 3_600;

    const result = await probeReachability(as, 20);

    expect(fake.asked).toBe(1);
    expect(result.reachable).toBe(false);
    // Still up, because it still holds a session it believes in — and still not
    // reachable, which is the fresher of the two facts.
    expect(result.state).toBe("up");
    expect(result.handshakeAgeSeconds).toBe(3_600);
  });

  it("leaves no listeners behind", async () => {
    const { fake, as } = device((d) => d.complete());

    await probeReachability(as, 50);

    // A probe per button press, on a device that lives as long as the peering:
    // a listener kept here is a leak that grows with use.
    expect(fake.listenerCount("handshake")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
  });
});

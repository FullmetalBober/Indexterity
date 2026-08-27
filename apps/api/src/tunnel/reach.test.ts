import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWireGuardConf } from "./conf";
import { probeReachability } from "./reach";
import { TunnelRegistry } from "./tunnel.registry";
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

// Everything above is a fake device. This is the part that cannot be faked: a
// handshake the reference implementation accepts, against a peer that is
// actually listening. Opt-in, because it needs a gateway — skipped, not failed,
// when there is none, so the ordinary suite is unaffected.
//
//   wg genkey > c.key; wg pubkey < c.key > c.pub
//   wg genkey > s.key; wg pubkey < s.key > s.pub
//   podman run --rm -d --name wgpeer --cap-add NET_ADMIN -p 51820:51820/udp \
//     -e SRVKEY="$(cat s.key)" -e CLIPUB="$(cat c.pub)" alpine:3 sh -c '
//       apk add --no-cache wireguard-tools iproute2 >/dev/null
//       ip link add wg0 type wireguard
//       printf "%s" "$SRVKEY" > /k
//       wg set wg0 listen-port 51820 private-key /k peer "$CLIPUB" allowed-ips 10.99.0.2/32
//       ip addr add 10.99.0.1/24 dev wg0; ip link set wg0 up; sleep 3600'
//
// Then a wg0.conf naming c.key, s.pub and 127.0.0.1:51820, and:
//
//   ALLOW_PRIVATE_CLUSTER_TARGETS=true WG_TEST_CONF=./wg0.conf npx vitest run src/tunnel/reach
//
// The flag is needed because the gateway is on loopback, which the network guard
// classifies PRIVATE — the same refusal a customer's RFC1918 gateway gets on a
// hosted install, and the reason this is a local proof rather than a CI job.
const CONF = process.env.WG_TEST_CONF;
const ID = "11111111-1111-4111-8111-111111111111";

describe.skipIf(CONF === undefined)("against a real WireGuard gateway", () => {
  it("completes a handshake, and completes another on the live session", async () => {
    const registry = new TunnelRegistry();
    const conf = parseWireGuardConf(readFileSync(CONF as string, "utf8"));
    try {
      await registry.open(ID, conf);
      const first = await registry.probe(ID);

      expect(first.reachable).toBe(true);
      expect(first.state).toBe("up");
      expect(first.error).toBeNull();
      expect(first.handshakeAgeSeconds).toBeLessThan(5);

      // The claim the dashboard's verdict rests on: a tunnel that is ALREADY up
      // still gets a fresh handshake, so "reachable" means the gateway answered
      // just now rather than an hour ago. A rekey does not change the state, so
      // a falling handshake age is the only thing that can show it happened.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const before = registry.health(ID)?.handshakeAgeSeconds ?? 0;
      const second = await registry.probe(ID);

      expect(before).toBeGreaterThan(1);
      expect(second.reachable).toBe(true);
      expect(second.handshakeAgeSeconds ?? Number.POSITIVE_INFINITY).toBeLessThan(before);
    } finally {
      await registry.close(ID);
    }
  }, 30_000);

  it("reports unreachable when nothing is listening on the endpoint", async () => {
    const registry = new TunnelRegistry();
    // The same gateway, one port along: permitted by the guard, answered by
    // nobody. This is the shape of every real failure — a moved endpoint, a
    // dropped UDP port, a revoked peer — and it has no cause to report.
    const conf = parseWireGuardConf(
      readFileSync(CONF as string, "utf8").replace(":51820", ":51821"),
    );
    try {
      await registry.open(ID, conf);
      const result = await registry.probe(ID, 3_000);

      expect(result.reachable).toBe(false);
      expect(result.state).toBe("handshaking");
      expect(result.error).toBeNull();
      expect(result.handshakeAgeSeconds).toBeNull();
    } finally {
      await registry.close(ID);
    }
  }, 30_000);
});

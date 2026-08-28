import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { parseWireGuardConf } from "./conf";
import { RemoteTunnel } from "./remote";

// The api's half of the protocol, against a stub service that speaks it and no
// WireGuard at all.
//
// What that isolates is the half worth isolating: the verdict this side gives a
// dial, and what a probe concludes from what came back. The protocol underneath
// is the service's own business and is tested in apps/tunnel; that the two agree
// end to end is what integration/tunnels.int.test.ts proves against the real
// service. This is the layer between, which neither of those would catch.
//
// The stub is a real TCP server in this process rather than a script on disk,
// which is the one improvement the move to a socket brings here for free: the
// commands this side sends are read directly instead of being echoed through the
// child's stderr, and a stub behaviour is a callback rather than a string of
// source code.

const CONF = parseWireGuardConf(
  [
    "[Interface]",
    "PrivateKey = 6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8=",
    "Address = 10.9.0.2/32",
    "DNS = 10.9.0.1",
    "",
    "[Peer]",
    "PublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=",
    "AllowedIPs = 10.0.0.0/8",
    "Endpoint = 203.0.113.7:51820",
  ].join("\n"),
);

const GATEWAY = { address: "203.0.113.7", port: 51_820 };
const ANNOUNCED_PORT = 34_567;

type Emit = (event: Record<string, unknown>) => void;

interface Stub {
  /** Once, after the listener has been announced. */
  readonly onStart?: (emit: Emit) => void;
  readonly onCommand?: (command: Record<string, string>, emit: Emit) => void;
  /** Drop the connection on this command instead of answering it. */
  readonly dropOn?: string;
}

interface Started {
  readonly tunnel: RemoteTunnel;
  readonly commands: string[];
  readonly errors: string[];
  readonly greetings: Record<string, unknown>[];
  readonly closes: number;
}

const servers: Server[] = [];
const open: RemoteTunnel[] = [];

async function listen(stub: Stub, greetings: Record<string, unknown>[], commands: string[]) {
  const server = createServer((socket: Socket) => {
    const emit: Emit = (event) => {
      socket.write(`${JSON.stringify(event)}\n`);
    };
    let greeted = false;
    createInterface({ input: socket }).on("line", (line) => {
      if (!greeted) {
        greeted = true;
        const greeting = JSON.parse(line) as Record<string, unknown>;
        greetings.push(greeting);
        // The real service refuses a greeting that names no peering by dropping
        // the connection, having said nothing.
        if (greeting.id === undefined || greeting.id === "") {
          socket.destroy();
          return;
        }
        emit({ type: "listening", port: ANNOUNCED_PORT, username: "u", password: "p" });
        stub.onStart?.(emit);
        return;
      }
      commands.push(line);
      const command = JSON.parse(line) as Record<string, string>;
      if (command.cmd === "shutdown") {
        socket.end();
        return;
      }
      if (stub.dropOn !== undefined && command.cmd === stub.dropOn) {
        socket.destroy();
        return;
      }
      stub.onCommand?.(command, emit);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub service did not listen on a port");
  }
  return address.port;
}

async function start(stub: Stub = {}, id = "tunnel-under-test"): Promise<Started> {
  const commands: string[] = [];
  const errors: string[] = [];
  const greetings: Record<string, unknown>[] = [];
  const counted = { closes: 0 };

  const port = await listen(stub, greetings, commands);

  const tunnel = await RemoteTunnel.connect({
    id,
    port,
    conf: CONF,
    gateway: GATEWAY,
    onError: (error) => errors.push(error.message),
    onState: () => {},
    onClose: () => {
      counted.closes += 1;
    },
  });
  open.push(tunnel);
  return {
    tunnel,
    commands,
    errors,
    greetings,
    get closes() {
      return counted.closes;
    },
  };
}

async function eventually(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met in time");
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((tunnel) => tunnel.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("talking to the tunnel service", () => {
  it("greets with the id and the key, on the connection and nowhere else", async () => {
    const { greetings } = await start();

    const greeting = greetings[0];
    // No credential: the service accepts a greeting because it arrived on
    // loopback, inside the api's own network namespace.
    expect(greeting?.token).toBeUndefined();
    expect(greeting?.id).toBe("tunnel-under-test");
    // The private key travels in the greeting: not on argv, which /proc exposes,
    // and not in a file that would outlive the peering.
    const config = greeting?.config as Record<string, unknown> | undefined;
    expect(config?.privateKey).toBe("6JPr8SWK9dFrjLwOWvGxJvVwt1nJKvXNTKLkS3LPvW8=");
    // Already resolved and vetted by the caller — the service refuses a hostname.
    const peer = config?.peer as Record<string, unknown> | undefined;
    expect(peer?.endpoint).toBe("203.0.113.7:51820");
  });

  it("takes the endpoint from the service's host and the port it announced", async () => {
    const { tunnel } = await start();

    // Straight into the DialProxy the three drivers already speak. The host is the
    // service's, not loopback: one shared SOCKS5 port serves every peering there,
    // and what makes this endpoint ours is the credentials.
    expect(tunnel.endpoint).toEqual({
      host: "127.0.0.1",
      port: ANNOUNCED_PORT,
      credentials: { username: "u", password: "p" },
    });
  });

  it("fails to connect when the service refuses the greeting", async () => {
    // A refused greeting is dropped without an answer, so this side has nothing
    // to report but the drop — which must be an error, not a tunnel that looks
    // open.
    await expect(start({}, "")).rejects.toThrow(/closed the connection/);
  });

  it("reports reachable once a handshake comes back", async () => {
    const { tunnel } = await start({
      onCommand: (command, emit) => {
        if (command.cmd === "handshake") emit({ type: "handshake", ageSeconds: 0.2 });
      },
    });

    const result = await tunnel.probe(2_000);

    expect(result.reachable).toBe(true);
    expect(result.error).toBeNull();
    expect(result.handshakeAgeSeconds ?? 99).toBeLessThan(5);
  });

  it("reports silence as unreachable without inventing a cause", async () => {
    // The gateway is off, or the port is dropped, or the PublicKey is wrong. All
    // three look exactly like this from here.
    const { tunnel } = await start();

    const result = await tunnel.probe(300);

    expect(result.reachable).toBe(false);
    expect(result.error).toBeNull();
    expect(result.handshakeAgeSeconds).toBeNull();
  });

  it("reports the service's own refusal when there is one", async () => {
    const { tunnel } = await start({
      onCommand: (command, emit) => {
        if (command.cmd === "handshake") {
          emit({ type: "error", message: "could not send a handshake initiation" });
        }
      },
    });

    const result = await tunnel.probe(300);

    expect(result.reachable).toBe(false);
    expect(result.error).toBe("could not send a handshake initiation");
  });

  it("does not ask again inside the window the service suppresses", async () => {
    const { tunnel, commands } = await start({
      onCommand: (command, emit) => {
        if (command.cmd === "handshake") emit({ type: "handshake", ageSeconds: 0 });
      },
    });

    const first = await tunnel.probe(2_000);
    const second = await tunnel.probe(2_000);

    expect(first.reachable).toBe(true);
    // wireguard-go suppresses an initiation sent within 5s of the last one and
    // returns nil, so a second ask would wait for an event that never comes. A
    // handshake that fresh IS the answer.
    expect(second.reachable).toBe(true);
    expect(commands.filter((line) => line.includes('"handshake"'))).toHaveLength(1);
  });

  it("allows a dial the guard permits, naming the address to use", async () => {
    const { commands } = await start({
      onStart: (emit) => {
        setTimeout(
          () => emit({ type: "dialRequest", id: "7", host: "10.1.2.3", port: 27_017 }),
          10,
        );
      },
    });

    await eventually(() => commands.some((line) => line.includes("dialAllow")));

    const verdict = commands.find((line) => line.includes("dialAllow"));
    expect(verdict).toContain('"id":"7"');
    expect(verdict).toContain('"address":"10.1.2.3:27017"');
  });

  it("refuses a dial the guard refuses, in the guard's own words", async () => {
    // Cloud metadata: FORBIDDEN whatever route reaches it, which is the rule
    // net-guard applies on the direct path too. The service holds no copy of it.
    const { commands } = await start({
      onStart: (emit) => {
        setTimeout(
          () => emit({ type: "dialRequest", id: "9", host: "169.254.169.254", port: 80 }),
          10,
        );
      },
    });

    await eventually(() => commands.some((line) => line.includes("dialDeny")));

    const verdict = commands.find((line) => line.includes("dialDeny"));
    expect(verdict).toContain('"id":"9"');
    expect(verdict).toContain("never a database");
  });

  it("refuses an address outside the peering's AllowedIPs", async () => {
    // 192.168.x is private and perfectly dialable in general — but this peer
    // agreed to carry 10.0.0.0/8 and nothing else.
    const { commands } = await start({
      onStart: (emit) => {
        setTimeout(
          () => emit({ type: "dialRequest", id: "4", host: "192.168.5.5", port: 5432 }),
          10,
        );
      },
    });

    await eventually(() => commands.some((line) => line.includes("dialDeny")));

    expect(commands.find((line) => line.includes("dialDeny"))).toContain("AllowedIPs");
  });

  it("answers a name by resolving it inside the tunnel first", async () => {
    const { commands } = await start({
      onStart: (emit) => {
        setTimeout(
          () => emit({ type: "dialRequest", id: "2", host: "db.internal", port: 27_017 }),
          10,
        );
      },
      onCommand: (command, emit) => {
        if (command.cmd === "resolve") {
          emit({ type: "resolved", id: command.id, addresses: ["10.4.5.6"] });
        }
      },
    });

    await eventually(() => commands.some((line) => line.includes("dialAllow")));

    // A name is never judged as a name: it goes to the customer's own resolver
    // and every answer is judged before any of them is dialled.
    expect(commands.some((line) => line.includes('"cmd":"resolve"'))).toBe(true);
    expect(commands.find((line) => line.includes("dialAllow"))).toContain('"10.4.5.6:27017"');
  });

  it("treats a name that does not resolve as a refusal, not an allowance", async () => {
    const { commands } = await start({
      onStart: (emit) => {
        setTimeout(
          () => emit({ type: "dialRequest", id: "3", host: "gone.internal", port: 27_017 }),
          10,
        );
      },
      onCommand: (command, emit) => {
        if (command.cmd === "resolve") {
          emit({ type: "failed", id: command.id, message: "gone.internal does not resolve" });
        }
      },
    });

    await eventually(() => commands.some((line) => line.includes("dialDeny")));

    expect(commands.find((line) => line.includes("dialDeny"))).toContain("does not resolve");
  });

  it("reports a connection that has gone rather than hanging", async () => {
    const started = await start({ dropOn: "handshake" });

    await started.tunnel.probe(2_000);
    await eventually(() => started.tunnel.health().state === "down");

    const after = await started.tunnel.probe(2_000);
    expect(after.reachable).toBe(false);
    expect(after.error).toBe("this peering's connection to the tunnel service is gone");
    // The registry hangs its map cleanup on this, which is what makes the next
    // open reconnect instead of reusing a dead endpoint.
    expect(started.closes).toBeGreaterThan(0);
    expect(started.tunnel.live).toBe(false);
  });
});

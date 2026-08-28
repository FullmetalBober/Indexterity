import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChildTunnel } from "./child";
import { parseWireGuardConf } from "./conf";

// The api's half of the pipe, against a stub that speaks the protocol and no
// WireGuard at all.
//
// What that isolates is the half worth isolating: the verdict this side gives a
// dial, and what a probe concludes from what came back. The protocol underneath
// is the binary's own business and is tested in apps/tunnel; that the two agree
// end to end is what integration/tunnels.int.test.ts proves against the real
// binary. This is the layer between, which neither of those would catch.

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

// A stub "binary": announces a listener, then does whatever `body` says with the
// commands it is sent. Every command is echoed to stderr, which is where the
// tests read what this side actually asked for.
function stubBinary(body: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "tunnel-stub-"));
  const file = path.join(directory, "stub");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const lines = readline.createInterface({ input: process.stdin });
let first = true;
lines.on("line", (line) => {
  if (first) {
    first = false;
    emit({ type: "listening", port: 34567, username: "u", password: "p" });
    ${body.includes("onStart") ? "onStart();" : ""}
    return;
  }
  process.stderr.write("cmd:" + line + "\\n");
  const command = JSON.parse(line);
  if (command.cmd === "shutdown") process.exit(0);
  onCommand(command, emit);
});
${body}
`,
    { mode: 0o755 },
  );
  return file;
}

interface Started {
  readonly tunnel: ChildTunnel;
  readonly commands: string[];
  readonly errors: string[];
}

const open: ChildTunnel[] = [];

async function start(body: string): Promise<Started> {
  const commands: string[] = [];
  const errors: string[] = [];
  const tunnel = await ChildTunnel.start({
    conf: CONF,
    gateway: GATEWAY,
    binary: stubBinary(body),
    onError: (error) => errors.push(error.message),
    onState: () => {},
    onExit: () => {},
    log: (line) => {
      if (line.startsWith("cmd:")) commands.push(line.slice(4));
    },
  });
  open.push(tunnel);
  return { tunnel, commands, errors };
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
});

describe("supervising the tunnel binary", () => {
  it("takes the endpoint from what the process announced", async () => {
    const { tunnel } = await start("function onCommand() {}");

    // Straight into the DialProxy the three drivers already speak.
    expect(tunnel.endpoint).toEqual({
      host: "127.0.0.1",
      port: 34567,
      credentials: { username: "u", password: "p" },
    });
  });

  it("reports reachable once a handshake comes back", async () => {
    const { tunnel } = await start(`function onCommand(command, emit) {
      if (command.cmd === "handshake") emit({ type: "handshake", ageSeconds: 0.2 });
    }`);

    const result = await tunnel.probe(2_000);

    expect(result.reachable).toBe(true);
    expect(result.error).toBeNull();
    expect(result.handshakeAgeSeconds ?? 99).toBeLessThan(5);
  });

  it("reports silence as unreachable without inventing a cause", async () => {
    // The gateway is off, or the port is dropped, or the PublicKey is wrong. All
    // three look exactly like this from here.
    const { tunnel } = await start("function onCommand() {}");

    const result = await tunnel.probe(300);

    expect(result.reachable).toBe(false);
    expect(result.error).toBeNull();
    expect(result.handshakeAgeSeconds).toBeNull();
  });

  it("reports the process's own refusal when there is one", async () => {
    const { tunnel } = await start(`function onCommand(command, emit) {
      if (command.cmd === "handshake") {
        emit({ type: "error", message: "could not send a handshake initiation" });
      }
    }`);

    const result = await tunnel.probe(300);

    expect(result.reachable).toBe(false);
    expect(result.error).toBe("could not send a handshake initiation");
  });

  it("does not ask again inside the window the binary suppresses", async () => {
    const { tunnel, commands } = await start(`function onCommand(command, emit) {
      if (command.cmd === "handshake") emit({ type: "handshake", ageSeconds: 0 });
    }`);

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
    const { commands } = await start(`function onStart() {
      setTimeout(() => emit({ type: "dialRequest", id: "7", host: "10.1.2.3", port: 27017 }), 10);
    }
    function onCommand() {}`);

    await eventually(() => commands.some((line) => line.includes("dialAllow")));

    const verdict = commands.find((line) => line.includes("dialAllow"));
    expect(verdict).toContain('"id":"7"');
    expect(verdict).toContain('"address":"10.1.2.3:27017"');
  });

  it("refuses a dial the guard refuses, in the guard's own words", async () => {
    // Cloud metadata: FORBIDDEN whatever route reaches it, which is the rule
    // net-guard applies on the direct path too. The binary holds no copy of it.
    const { commands } = await start(`function onStart() {
      setTimeout(
        () => emit({ type: "dialRequest", id: "9", host: "169.254.169.254", port: 80 }),
        10,
      );
    }
    function onCommand() {}`);

    await eventually(() => commands.some((line) => line.includes("dialDeny")));

    const verdict = commands.find((line) => line.includes("dialDeny"));
    expect(verdict).toContain('"id":"9"');
    expect(verdict).toContain("never a database");
  });

  it("refuses an address outside the peering's AllowedIPs", async () => {
    // 192.168.x is private and perfectly dialable in general — but this peer
    // agreed to carry 10.0.0.0/8 and nothing else.
    const { commands } = await start(`function onStart() {
      setTimeout(
        () => emit({ type: "dialRequest", id: "4", host: "192.168.5.5", port: 5432 }),
        10,
      );
    }
    function onCommand() {}`);

    await eventually(() => commands.some((line) => line.includes("dialDeny")));

    expect(commands.find((line) => line.includes("dialDeny"))).toContain("AllowedIPs");
  });

  it("answers a name by resolving it inside the tunnel first", async () => {
    const { commands } = await start(`function onStart() {
      setTimeout(
        () => emit({ type: "dialRequest", id: "2", host: "db.internal", port: 27017 }),
        10,
      );
    }
    function onCommand(command, emit) {
      if (command.cmd === "resolve") {
        emit({ type: "resolved", id: command.id, addresses: ["10.4.5.6"] });
      }
    }`);

    await eventually(() => commands.some((line) => line.includes("dialAllow")));

    // A name is never judged as a name: it goes to the customer's own resolver
    // and every answer is judged before any of them is dialled.
    expect(commands.some((line) => line.includes('"cmd":"resolve"'))).toBe(true);
    expect(commands.find((line) => line.includes("dialAllow"))).toContain('"10.4.5.6:27017"');
  });

  it("treats a name that does not resolve as a refusal, not an allowance", async () => {
    const { commands } = await start(`function onStart() {
      setTimeout(
        () => emit({ type: "dialRequest", id: "3", host: "gone.internal", port: 27017 }),
        10,
      );
    }
    function onCommand(command, emit) {
      if (command.cmd === "resolve") {
        emit({ type: "failed", id: command.id, message: "gone.internal does not resolve" });
      }
    }`);

    await eventually(() => commands.some((line) => line.includes("dialDeny")));

    expect(commands.find((line) => line.includes("dialDeny"))).toContain("does not resolve");
  });

  it("reports a process that has gone rather than hanging", async () => {
    const { tunnel } = await start(`function onCommand(command) {
      if (command.cmd === "handshake") process.exit(1);
    }`);

    await tunnel.probe(2_000);
    await eventually(() => tunnel.health().state === "down");

    const after = await tunnel.probe(2_000);
    expect(after.reachable).toBe(false);
    expect(after.error).toBe("the tunnel process is gone");
  });
});

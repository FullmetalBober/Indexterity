import { type ChildProcess, spawn } from "node:child_process";
import { isIP } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { assertDialableThroughTunnel, type Cidr, parseCidr } from "../engine/net-guard";
import type { TunnelBackend, TunnelEndpoint, TunnelHealth } from "./backend";
import type { WireGuardConf } from "./conf";
import type { Reachability } from "./reach";
import type { DeviceState } from "./wireguard/device";

// The peering carried by apps/tunnel: wireguard-go for the protocol, gvisor's
// netstack for IP and TCP, one process per tunnel (D111).
//
// This file is the api's half of that contract, and the whole of the difference
// is who answers what. The binary carries packets and holds NO policy: it asks
// about every dial it is given, including one whose host is already an address,
// and this class answers with the same assertDialableThroughTunnel the direct
// path uses. The gateway is resolved and vetted HERE too, before the process is
// started — a hostname reaching the binary is refused by it, because resolving
// one there would skip the guard.
//
// Two pipe round trips per CONNECTION, and none per packet.

// The binary's stdout, parsed rather than trusted: it is a separate artefact
// that a deployment could have at a different version, and an event we cannot
// read is better reported than silently ignored.
const tunnelEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("listening"),
    port: z.int().min(1).max(65_535),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({ type: z.literal("state"), state: z.enum(["down", "handshaking", "up"]) }),
  z.object({ type: z.literal("handshake"), ageSeconds: z.number().nonnegative() }),
  z.object({ type: z.literal("resolved"), id: z.string(), addresses: z.array(z.string()) }),
  z.object({ type: z.literal("failed"), id: z.string(), message: z.string() }),
  z.object({
    type: z.literal("dialRequest"),
    id: z.string(),
    host: z.string(),
    port: z.int().min(1).max(65_535),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

/** How long the binary gets to report its listener before the open is a failure. */
const START_TIMEOUT_MS = 15_000;
/** A resolver inside a tunnel that is not up takes as long as it takes. */
const RESOLVE_TIMEOUT_MS = 10_000;
/**
 * wireguard-go suppresses a handshake initiation sent within 5s of the last one,
 * which is its own flood protection. So a handshake younger than that IS the
 * answer a probe is looking for — the gateway demonstrably answered inside the
 * window — and asking for another would wait for an event that will not come.
 */
const HANDSHAKE_SUPPRESSION_MS = 5_000;
/** After shutdown is asked for politely. */
const EXIT_GRACE_MS = 5_000;

// The default location: the layout the repo and the image share, resolved from
// this module rather than from the working directory, so `dist/` and `src/` — one
// level under apps/api either way — both land on apps/tunnel/dist.
function defaultBinary(): string {
  return path.resolve(__dirname, "../../../tunnel/dist/indexterity-tunnel");
}

interface Waiter {
  readonly resolve: (addresses: readonly string[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class ChildTunnel implements TunnelBackend {
  readonly endpoint: TunnelEndpoint;
  readonly #child: ChildProcess;
  readonly #allowedIps: readonly Cidr[];
  readonly #onError: (error: Error) => void;

  #state: DeviceState = "down";
  #lastHandshakeAt: number | null = null;
  #lastError: Error | null = null;
  #exited = false;
  #nextId = 0;
  readonly #resolving = new Map<string, Waiter>();
  readonly #handshakeWaiters = new Set<() => void>();

  private constructor(
    child: ChildProcess,
    endpoint: TunnelEndpoint,
    allowedIps: readonly Cidr[],
    onError: (error: Error) => void,
  ) {
    this.#child = child;
    this.endpoint = endpoint;
    this.#allowedIps = allowedIps;
    this.#onError = onError;
  }

  /**
   * Spawn the binary and wait for it to report its listener.
   *
   * `gateway` is already resolved and vetted as a PUBLIC target by the caller,
   * which is the same check the in-process device makes per attempt. The
   * difference — and it is worth naming — is that the child holds the address it
   * was given rather than re-resolving per attempt, so a gateway on dynamic DNS
   * moves when the api pushes an `endpoint` command. probe() re-pushes, which
   * makes Test the thing that recovers a moved gateway.
   */
  static async start(options: {
    readonly conf: WireGuardConf;
    readonly gateway: { readonly address: string; readonly port: number };
    readonly binary?: string | undefined;
    readonly onError: (error: Error) => void;
    readonly onState: (state: string) => void;
    readonly onExit: (code: number | null) => void;
    readonly log: (message: string) => void;
  }): Promise<ChildTunnel> {
    const executable = options.binary ?? defaultBinary();
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      throw new Error("could not open a pipe to the tunnel process");
    }

    const allowedIps = options.conf.peer.allowedIps.map(parseCidr);
    let tunnel: ChildTunnel | null = null;
    // Events that arrive between `listening` and the instance existing — one
    // microtask, but the FIRST state change and the first handshake land in it,
    // and a dropped handshake is a probe that reports a healthy gateway as
    // silent. Held, then replayed in order.
    const buffered: z.infer<typeof tunnelEvent>[] = [];

    const listening = new Promise<TunnelEndpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the tunnel process did not start within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
      timer.unref?.();

      child.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`could not start ${executable}: ${error.message}`));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the tunnel process exited with ${code ?? "a signal"} before listening`));
      });

      const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
      lines.on("line", (line) => {
        const parsed = tunnelEvent.safeParse(safeJson(line));
        if (!parsed.success) {
          options.onError(new Error(`unreadable event from the tunnel process: ${line}`));
          return;
        }
        const event = parsed.data;
        if (event.type === "listening") {
          clearTimeout(timer);
          resolve({
            host: "127.0.0.1",
            port: event.port,
            credentials: { username: event.username, password: event.password },
          });
          return;
        }
        if (tunnel === null) {
          buffered.push(event);
          return;
        }
        tunnel.handle(event);
      });
    });

    // The private key, on stdin and nowhere else: argv is world-readable through
    // /proc and a file outlives the process that needed it.
    child.stdin.write(`${JSON.stringify(configFor(options.conf, options.gateway))}\n`);

    const stderr = createInterface({ input: child.stderr as NodeJS.ReadableStream });
    stderr.on("line", (line) => options.log(line));

    child.on("exit", (code) => {
      tunnel?.markExited();
      options.onExit(code);
    });

    let endpoint: TunnelEndpoint;
    try {
      endpoint = await listening;
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }

    tunnel = new ChildTunnel(child, endpoint, allowedIps, options.onError);
    tunnel.#onStateChange = options.onState;
    for (const event of buffered) tunnel.handle(event);
    buffered.length = 0;
    return tunnel;
  }

  #onStateChange: (state: string) => void = () => {};

  /**
   * One parsed event, from the reader start() attached. Public because that
   * reader outlives the constructor and replays what it buffered.
   */
  handle(event: z.infer<typeof tunnelEvent>): void {
    switch (event.type) {
      case "listening":
        // Already consumed by start(); a second one would mean the binary
        // restarted its listener under us, which it never does.
        return;
      case "state": {
        this.#state = event.state;
        this.#onStateChange(event.state);
        return;
      }
      case "handshake": {
        this.#lastHandshakeAt = Date.now() - event.ageSeconds * 1000;
        for (const waiter of [...this.#handshakeWaiters]) waiter();
        return;
      }
      case "resolved": {
        const waiter = this.#resolving.get(event.id);
        if (waiter === undefined) return;
        this.#resolving.delete(event.id);
        clearTimeout(waiter.timer);
        waiter.resolve(event.addresses);
        return;
      }
      case "failed": {
        const waiter = this.#resolving.get(event.id);
        if (waiter === undefined) return;
        this.#resolving.delete(event.id);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(event.message));
        return;
      }
      case "dialRequest": {
        void this.#answerDial(event.id, event.host, event.port);
        return;
      }
      case "error": {
        this.#lastError = new Error(event.message);
        this.#onError(this.#lastError);
        return;
      }
    }
  }

  markExited(): void {
    this.#exited = true;
    this.#state = "down";
    for (const [id, waiter] of this.#resolving) {
      this.#resolving.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the tunnel process is gone"));
    }
    for (const waiter of [...this.#handshakeWaiters]) waiter();
  }

  /**
   * The verdict on one dial, which is where the guard stays ours.
   *
   * EVERY address the resolver returned is judged before any of them is dialled
   * — a permitted A record must not excuse a forbidden AAAA record, which is the
   * rule the in-process netstack applies at the same point.
   */
  async #answerDial(id: string, host: string, port: number): Promise<void> {
    try {
      const addresses = isIP(host) !== 0 ? [host] : await this.resolve(host);
      if (addresses.length === 0) {
        this.#send({
          cmd: "dialDeny",
          id,
          message: `${host} resolves to nothing inside the tunnel`,
        });
        return;
      }
      for (const address of addresses) assertDialableThroughTunnel(address, this.#allowedIps);
      const first = addresses[0];
      if (first === undefined) throw new Error("no address to dial");
      this.#send({ cmd: "dialAllow", id, address: socketAddress(first, port) });
    } catch (error) {
      // The guard's own sentence, or the resolver's. Silence would be read by
      // the binary as a refusal after its timeout anyway, but late and without
      // the reason.
      this.#send({ cmd: "dialDeny", id, message: (error as Error).message });
    }
  }

  async resolve(host: string): Promise<readonly string[]> {
    if (this.#exited) throw new Error("the tunnel process is gone");
    const id = String(++this.#nextId);
    return new Promise<readonly string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#resolving.delete(id);
        reject(new Error(`${host} was not resolved within ${RESOLVE_TIMEOUT_MS}ms`));
      }, RESOLVE_TIMEOUT_MS);
      timer.unref?.();
      this.#resolving.set(id, { resolve, reject, timer });
      this.#send({ cmd: "resolve", id, host });
    });
  }

  health(): TunnelHealth {
    return {
      state: this.#state,
      handshakeAgeSeconds:
        this.#lastHandshakeAt === null ? null : (Date.now() - this.#lastHandshakeAt) / 1000,
    };
  }

  async probe(timeoutMs = 8_000): Promise<Reachability> {
    if (this.#exited) {
      return {
        reachable: false,
        state: "down",
        handshakeAgeSeconds: null,
        error: "the tunnel process is gone",
      };
    }

    const age = this.health().handshakeAgeSeconds;
    if (age !== null && age * 1000 < HANDSHAKE_SUPPRESSION_MS) {
      // Already proven, inside the window where another initiation would be
      // suppressed anyway. Reporting it is honest: the gateway answered less
      // than five seconds ago.
      return { reachable: true, state: this.#state, handshakeAgeSeconds: age, error: null };
    }

    this.#clearLastError();
    const before = this.#lastHandshakeAt;
    await this.#waitForHandshake(before, timeoutMs);

    const answered = this.#lastHandshakeAt !== null && this.#lastHandshakeAt !== before;
    return {
      reachable: answered,
      state: this.#state,
      handshakeAgeSeconds: this.health().handshakeAgeSeconds,
      error: answered ? null : this.#lastErrorMessage(),
    };
  }

  // Read and cleared through methods rather than inline: an assignment to a
  // field in one branch narrows it for the rest of the function, and the reader
  // here is looking for what a LISTENER wrote in between.
  #clearLastError(): void {
    this.#lastError = null;
  }

  #lastErrorMessage(): string | null {
    return this.#lastError === null ? null : this.#lastError.message;
  }

  async #waitForHandshake(before: number | null, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#handshakeWaiters.delete(waiter);
        resolve();
      };
      const waiter = () => {
        if (this.#lastHandshakeAt !== before) done();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.#handshakeWaiters.add(waiter);
      this.#send({ cmd: "handshake" });
    });
  }

  /** A gateway that has moved, re-resolved and re-vetted by the caller. */
  moveEndpoint(gateway: { address: string; port: number }): void {
    this.#send({ cmd: "endpoint", endpoint: socketAddress(gateway.address, gateway.port) });
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
    this.#send({ cmd: "shutdown" });
    this.#child.stdin?.end();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXIT_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (!this.#exited) this.#child.kill("SIGKILL");
  }

  #send(command: Record<string, string | number>): void {
    const stdin = this.#child.stdin;
    if (stdin === null || this.#exited) return;
    // A failed write means the pipe is gone, which the exit handler is already
    // dealing with; there is nothing a caller could do with the error.
    stdin.write(`${JSON.stringify(command)}\n`, () => {});
  }
}

// The serialization the binary's own config struct expects, field for field. It
// refuses unknown fields, so a mismatch here fails loudly at start rather than
// carrying an AllowedIPs nobody chose.
function configFor(
  conf: WireGuardConf,
  gateway: { readonly address: string; readonly port: number },
): Record<string, unknown> {
  return {
    privateKey: conf.privateKey.toString("base64"),
    addresses: [...conf.addresses],
    dns: [...conf.dns],
    mtu: conf.mtu,
    peer: {
      publicKey: conf.peer.publicKey.toString("base64"),
      ...(conf.peer.presharedKey === undefined
        ? {}
        : { presharedKey: conf.peer.presharedKey.toString("base64") }),
      allowedIps: [...conf.peer.allowedIps],
      endpoint: socketAddress(gateway.address, gateway.port),
      ...(conf.peer.persistentKeepalive === undefined
        ? {}
        : { persistentKeepalive: conf.peer.persistentKeepalive }),
    },
  };
}

// netip.ParseAddrPort on the far side, which wants an IPv6 address in brackets.
function socketAddress(address: string, port: number): string {
  return isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

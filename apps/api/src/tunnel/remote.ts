import net, { isIP, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";
import { assertDialableThroughTunnel, type Cidr, parseCidr } from "../engine/net-guard";
import type { WireGuardConf } from "./conf";

// The peering carried by apps/tunnel: wireguard-go for the protocol, gvisor's
// netstack for IP and TCP, in a service the api connects to (D113, amending
// D111's process per tunnel).
//
// This file is the api's half of that contract, and the whole of the difference
// is who answers what. The service carries packets and holds NO policy: it asks
// about every dial it is given, including one whose host is already an address,
// and this class answers with the same assertDialableThroughTunnel the direct
// path uses. The gateway is resolved and vetted HERE too, before the greeting is
// sent — a hostname reaching the service is refused by it, because resolving one
// there would skip the guard.
//
// One CONNECTION per peering, on LOOPBACK, and what it carries is the same
// line-delimited JSON the pipe carried. Two round trips per dial, and none per
// packet.
//
// Loopback is what keeps this as safe as the pipe it replaced. The service runs
// in the api's own network namespace — one container in the all-in-one image, a
// sidecar in the api's pod — so a customer's private key never crosses a network
// and the SOCKS5 proxy into their network is reachable from nowhere else. There
// is no token, because there is no listener a stranger could reach.
//
// The connection IS the peering: there is no handle to a peering that outlives
// its socket, which is what makes a lost api the end of a live session rather
// than an orphan nobody is watching.

/** down | handshaking | up, which is what the dashboard draws. */
export type TunnelState = "down" | "handshaking" | "up";

export interface TunnelEndpoint {
  /**
   * Loopback SOCKS5 the drivers dial. The service shares this network namespace,
   * so the only thing that varies per peering is the port and the credentials.
   */
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly credentials: { readonly username: string; readonly password: string };
}

export interface TunnelHealth {
  readonly state: TunnelState;
  readonly handshakeAgeSeconds: number | null;
}

/**
 * What a reachability test found. `error` is null when the gateway answered, and
 * ALSO when it simply stayed silent: an endpoint that is not there, a dropped UDP
 * port and a PublicKey the gateway does not know are indistinguishable from
 * here, so there is no cause to report and inventing one would send an owner
 * somewhere specific for a reason nobody has.
 */
export interface Reachability {
  readonly reachable: boolean;
  readonly state: TunnelState;
  readonly handshakeAgeSeconds: number | null;
  readonly error: string | null;
}

// The service's events, parsed rather than trusted: it is a separate artefact
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

/** The service shares this network namespace; there is no other address it could be at. */
const LOOPBACK = "127.0.0.1";

/** How long the service gets to report its listener before the open is a failure. */
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
/** After shutdown is asked for politely, before the socket is destroyed. */
const CLOSE_GRACE_MS = 5_000;

interface Waiter {
  readonly resolve: (addresses: readonly string[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RemoteTunnel {
  readonly endpoint: TunnelEndpoint;
  /**
   * The peering's AllowedIPs as the conf wrote them.
   *
   * Kept alongside the parsed form because the guard has two callers with two
   * shapes: this class judges addresses itself against #allowedIps, and the
   * engine adapters are handed a TunnelRoute carrying the strings — member
   * discovery being the one that needs it (#382).
   */
  readonly allowedIps: readonly string[];
  readonly #socket: Socket;
  readonly #allowedIps: readonly Cidr[];
  readonly #onError: (error: Error) => void;

  #state: TunnelState = "down";
  #lastHandshakeAt: number | null = null;
  #lastError: Error | null = null;
  #gone = false;
  #nextId = 0;
  readonly #resolving = new Map<string, Waiter>();
  readonly #handshakeWaiters = new Set<() => void>();

  private constructor(
    socket: Socket,
    endpoint: TunnelEndpoint,
    allowedIps: readonly string[],
    onError: (error: Error) => void,
  ) {
    this.#socket = socket;
    this.endpoint = endpoint;
    this.allowedIps = allowedIps;
    this.#allowedIps = allowedIps.map(parseCidr);
    this.#onError = onError;
  }

  /** Whether this peering's connection is still there. */
  get live(): boolean {
    return !this.#gone;
  }

  /**
   * Connect to the tunnel service, greet it, and wait for it to report its
   * listener.
   *
   * `gateway` is already resolved and vetted as a PUBLIC target by the caller,
   * which is the same check the device makes per attempt. The difference — and it
   * is worth naming — is that the service holds the address it was given rather
   * than re-resolving per attempt, so a gateway on dynamic DNS moves when the api
   * pushes an `endpoint` command. probe() re-pushes, which makes Test the thing
   * that recovers a moved gateway.
   */
  static async connect(options: {
    readonly id: string;
    /** The loopback port the service's control listener is on. */
    readonly port: number;
    readonly conf: WireGuardConf;
    readonly gateway: { readonly address: string; readonly port: number };
    readonly onError: (error: Error) => void;
    readonly onState: (state: string) => void;
    readonly onClose: () => void;
  }): Promise<RemoteTunnel> {
    const socket = net.connect({ host: LOOPBACK, port: options.port });
    // Nagle off. Every write here is a whole command or a whole event, so holding
    // one back to coalesce it with the next only adds latency — and the thing
    // waiting on it is a dial verdict with a database driver behind it.
    socket.setNoDelay(true);

    const allowedIps = [...options.conf.peer.allowedIps];
    let tunnel: RemoteTunnel | null = null;
    // Events that arrive between `listening` and the instance existing — one
    // microtask, but the FIRST state change and the first handshake land in it,
    // and a dropped handshake is a probe that reports a healthy gateway as
    // silent. Held, then replayed in order.
    const buffered: z.infer<typeof tunnelEvent>[] = [];

    const listening = new Promise<TunnelEndpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the tunnel service did not answer within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
      timer.unref?.();

      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `could not reach the tunnel service on ${LOOPBACK}:${options.port}: ${error.message}`,
          ),
        );
      });
      socket.once("close", () => {
        clearTimeout(timer);
        // Dropped before a listener was announced, which is how a refused
        // greeting looks from here: a token that did not match, or a config the
        // service could not bring up. The service says which on its own stderr,
        // and deliberately tells an unauthenticated caller nothing.
        reject(new Error("the tunnel service closed the connection before announcing a listener"));
      });

      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const parsed = tunnelEvent.safeParse(safeJson(line));
        if (!parsed.success) {
          options.onError(new Error(`unreadable event from the tunnel service: ${line}`));
          return;
        }
        const event = parsed.data;
        if (event.type === "listening") {
          clearTimeout(timer);
          resolve({
            // The port the service announced. One shared SOCKS5 listener serves
            // every peering it holds, so what makes this endpoint THIS peering's
            // is the credentials, not the port.
            host: LOOPBACK,
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

    // The private key, on the connection and nowhere else: argv is world-readable
    // through /proc and a file outlives the process that needed it. The connection
    // is loopback, so it does not leave the network namespace either.
    socket.write(`${JSON.stringify(helloFor(options.id, options.conf, options.gateway))}\n`);

    socket.on("close", () => {
      tunnel?.markGone();
      options.onClose();
    });

    let endpoint: TunnelEndpoint;
    try {
      endpoint = await listening;
    } catch (error) {
      socket.destroy();
      throw error;
    }

    tunnel = new RemoteTunnel(socket, endpoint, allowedIps, options.onError);
    tunnel.#onStateChange = options.onState;
    for (const event of buffered) tunnel.handle(event);
    buffered.length = 0;
    return tunnel;
  }

  #onStateChange: (state: string) => void = () => {};

  /**
   * One parsed event, from the reader connect() attached. Public because that
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

  markGone(): void {
    this.#gone = true;
    this.#state = "down";
    for (const [id, waiter] of this.#resolving) {
      this.#resolving.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("this peering's connection to the tunnel service is gone"));
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
    if (this.#gone) throw new Error("this peering's connection to the tunnel service is gone");
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
    if (this.#gone) {
      return {
        reachable: false,
        state: "down",
        handshakeAgeSeconds: null,
        error: "this peering's connection to the tunnel service is gone",
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

  /**
   * Ask the service to drop this peering, then close the connection.
   *
   * Both, in that order, and the second is what actually guarantees it: the
   * service treats a closed connection as the end of the peering, so a `shutdown`
   * that is never read still ends with the device down. The polite command is
   * there so the ordinary case is orderly rather than a reset.
   */
  async close(): Promise<void> {
    if (this.#gone) return;
    const closed = new Promise<void>((resolve) => this.#socket.once("close", () => resolve()));
    this.#send({ cmd: "shutdown" });
    this.#socket.end();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (!this.#gone) this.#socket.destroy();
  }

  #send(command: Record<string, string | number>): void {
    if (this.#gone || this.#socket.writableEnded) return;
    // A failed write means the connection is gone, which the close handler is
    // already dealing with; there is nothing a caller could do with the error.
    this.#socket.write(`${JSON.stringify(command)}\n`, () => {});
  }
}

// The greeting, field for field as the service's own structs expect it. Unknown
// fields are refused on that side, so a mismatch here fails loudly at connect
// rather than carrying an AllowedIPs nobody chose.
//
// There is no credential in it: the service accepts a greeting because it arrived
// on loopback. The id is for its log, not for routing — what selects a peering on
// the data path is the credential handed back in `listening`.
function helloFor(
  id: string,
  conf: WireGuardConf,
  gateway: { readonly address: string; readonly port: number },
): Record<string, unknown> {
  return { id, config: configFor(conf, gateway) };
}

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

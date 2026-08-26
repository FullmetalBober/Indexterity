import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import {
  consumeResponse,
  createInitiation,
  type HandshakeState,
  MESSAGE_RESPONSE,
  MESSAGE_TRANSPORT,
  messageType,
  type StaticKeys,
} from "./handshake";
import { REKEY_AFTER_TIME_MS, Session } from "./session";

// Drives the protocol: one UDP socket, one peer, and the timers that keep a
// session alive. The layers either side of it stay ignorant of each other —
// handshake.ts and session.ts are pure transforms, and the netstack above sees
// only "here is an IP packet" in both directions.

// Whitepaper §6.1, again the reference implementation's numbers.
const REKEY_TIMEOUT_MS = 5_000;
const REKEY_ATTEMPT_TIME_MS = 90_000;
// No default keepalive constant: WireGuard's own default is OFF, and inventing
// one here would send traffic a config did not ask for. The customer's
// PersistentKeepalive decides, and 25s is what wg-quick suggests when it is
// needed at all.

export interface DeviceOptions {
  readonly keys: StaticKeys;
  /**
   * Resolved fresh for each handshake attempt rather than once at construction.
   * A callback, not a host:port, because resolving it is where the network
   * guard vets the gateway as a PUBLIC target — a customer-supplied endpoint is
   * an outbound dial we make, and unvetted it is a request-forgery hole wearing
   * the tunnel's clothes. Keeping it a callback also means a gateway on dynamic
   * DNS recovers on the next attempt instead of pinning a dead address.
   */
  readonly resolveEndpoint: () => Promise<{ address: string; port: number }>;
  readonly persistentKeepalive?: number;
}

export type DeviceState = "down" | "handshaking" | "up";

// Typed through EventEmitter's generic rather than by merging an interface into
// the class: the merge is the usual trick for this, and it also lets a later
// declaration silently widen the class, which is what biome objects to.
type DeviceEvents = {
  packet: [Buffer];
  state: [DeviceState];
  error: [Error];
};

export class TunnelDevice extends EventEmitter<DeviceEvents> {
  #options: DeviceOptions;
  #socket: dgram.Socket | null = null;
  #session: Session | null = null;
  #pending: HandshakeState | null = null;
  #state: DeviceState = "down";
  #closed = false;

  #handshakeStartedAt = 0;
  #lastHandshakeAt: number | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #keepaliveTimer: NodeJS.Timeout | null = null;

  // Packets asked for before a session exists. Bounded: an unreachable gateway
  // must not turn into unbounded memory on the api pod, and a database driver
  // that cannot send will time out and retry anyway — which is a better outcome
  // than a queue that grows until the process dies.
  #queue: Buffer[] = [];
  static readonly MAX_QUEUED_PACKETS = 128;

  constructor(options: DeviceOptions) {
    super();
    this.#options = options;
  }

  get state(): DeviceState {
    return this.#state;
  }

  /** Seconds since the last completed handshake, or null if there has never been one. */
  handshakeAgeSeconds(now: number = Date.now()): number | null {
    return this.#lastHandshakeAt === null ? null : (now - this.#lastHandshakeAt) / 1000;
  }

  async start(): Promise<void> {
    if (this.#socket !== null) return;
    const socket = dgram.createSocket("udp4");
    this.#socket = socket;
    socket.on("message", (datagram) => this.#receive(datagram));
    socket.on("error", (error) => this.emit("error", error));
    await new Promise<void>((resolve) => socket.bind(0, resolve));
    await this.#beginHandshake();
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    if (this.#keepaliveTimer !== null) clearInterval(this.#keepaliveTimer);
    this.#retryTimer = null;
    this.#keepaliveTimer = null;
    this.#socket?.close();
    this.#socket = null;
    this.#session = null;
    this.#pending = null;
    this.#queue = [];
    this.#setState("down");
  }

  /** Hand an IP packet to the tunnel. Queued if the session is not up yet. */
  send(packet: Uint8Array): void {
    if (this.#closed) throw new Error("tunnel is closed");
    const session = this.#session;
    if (session === null || session.expired()) {
      if (this.#queue.length < TunnelDevice.MAX_QUEUED_PACKETS)
        this.#queue.push(Buffer.from(packet));
      void this.#beginHandshake();
      return;
    }
    // Rekeying does NOT stop the current session being used: the replacement is
    // negotiated alongside, so a rekey costs no dropped packets.
    if (session.needsRekey()) void this.#beginHandshake();
    this.#write(session.encapsulate(packet));
  }

  #setState(state: DeviceState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit("state", state);
  }

  #write(datagram: Buffer): void {
    const socket = this.#socket;
    if (socket === null) return;
    void this.#options
      .resolveEndpoint()
      .then(({ address, port }) => socket.send(datagram, port, address))
      .catch((error: Error) => this.emit("error", error));
  }

  async #beginHandshake(): Promise<void> {
    if (this.#closed || this.#socket === null) return;
    // One attempt in flight at a time, and no restart inside the retry window —
    // otherwise every queued packet would start its own handshake and the peer
    // would see a flood it is entitled to treat as an attack.
    const now = Date.now();
    if (this.#pending !== null && now - this.#handshakeStartedAt < REKEY_TIMEOUT_MS) return;

    if (this.#session === null) this.#setState("handshaking");
    this.#handshakeStartedAt = now;

    try {
      const { message, state } = createInitiation(this.#options.keys);
      this.#pending = state;
      this.#write(message);
    } catch (error) {
      this.#pending = null;
      this.emit("error", error as Error);
      return;
    }

    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      // Give up on THIS attempt after the reference implementation's window.
      // Giving up is a state, not an error: the tunnel reports itself down and
      // the next packet starts a fresh attempt, so a gateway that comes back
      // recovers without anything having to be restarted.
      if (Date.now() - this.#handshakeStartedAt >= REKEY_ATTEMPT_TIME_MS) {
        this.#pending = null;
        if (this.#session === null) this.#setState("down");
        return;
      }
      void this.#beginHandshake();
    }, REKEY_TIMEOUT_MS);
    this.#retryTimer.unref?.();
  }

  #receive(datagram: Buffer): void {
    const type = messageType(datagram);
    if (type === MESSAGE_RESPONSE) {
      this.#completeHandshake(datagram);
      return;
    }
    if (type !== MESSAGE_TRANSPORT) return;

    const session = this.#session;
    if (session === null) return;
    // The receiver index says which of our sessions a datagram belongs to; a
    // stale one arriving after a rekey is not an error, just not ours.
    if (datagram.length >= 8 && datagram.readUInt32LE(4) !== session.localIndex) return;

    try {
      const packet = session.decapsulate(datagram);
      // A keepalive is a transport packet with an empty payload. It decrypts to
      // padding, and the netstack above must never be handed it as an IP packet.
      if (packet.length === 0 || packet.every((byte) => byte === 0)) return;
      this.emit("packet", packet);
    } catch (error) {
      this.emit("error", error as Error);
    }
  }

  #completeHandshake(datagram: Buffer): void {
    const pending = this.#pending;
    if (pending === null) return;
    let session: Session;
    try {
      session = new Session(consumeResponse(pending, datagram));
    } catch (error) {
      // A response that does not verify is not fatal — it may be for a session
      // we have already replaced, or forged. Keep the retry running.
      this.emit("error", error as Error);
      return;
    }

    this.#pending = null;
    this.#session = session;
    this.#lastHandshakeAt = Date.now();
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#setState("up");

    const queued = this.#queue;
    this.#queue = [];
    for (const packet of queued) this.#write(session.encapsulate(packet));

    this.#startKeepalive();
    this.#scheduleRekey();
  }

  #startKeepalive(): void {
    const interval = this.#options.persistentKeepalive;
    if (interval === undefined || this.#keepaliveTimer !== null) return;
    this.#keepaliveTimer = setInterval(() => {
      const session = this.#session;
      if (session === null || session.expired()) return;
      // An empty payload: this is what holds a NAT mapping open on the
      // customer's side, which is the whole reason a gateway behind NAT stays
      // reachable between collects.
      this.#write(session.encapsulate(Buffer.alloc(0)));
    }, interval * 1000);
    this.#keepaliveTimer.unref?.();
  }

  #scheduleRekey(): void {
    const timer = setTimeout(() => {
      if (this.#closed || this.#session === null) return;
      void this.#beginHandshake();
    }, REKEY_AFTER_TIME_MS);
    timer.unref?.();
  }
}

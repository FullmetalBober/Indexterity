import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { TunnelNetstack } from "./netstack";

// A SOCKS5 front end for one tunnel, on loopback.
//
// SOCKS rather than handing each driver a netstack socket, because the three
// drivers already have a dial hook and two of them speak SOCKS with no adapter
// at all — mongodb takes proxyHost/proxyPort natively, tedious takes
// options.connector. Measured, not assumed: all three complete a real dial
// through a SOCKS5 proxy, TLS included.
//
// The property that makes it the right choice rather than merely a working one
// is that all three send the destination AS A HOSTNAME (address type 3). That
// is what lets resolution happen on the far side of the tunnel, where a private
// replica set's member names are the only place they mean anything.

const VERSION = 0x05;
const AUTH_VERSION = 0x01;
const METHOD_USERPASS = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REPLY_SUCCESS = 0x00;
const REPLY_GENERAL_FAILURE = 0x01;
const REPLY_NOT_ALLOWED = 0x02;
const REPLY_HOST_UNREACHABLE = 0x04;
const REPLY_COMMAND_UNSUPPORTED = 0x07;

const NEGOTIATION_TIMEOUT_MS = 20_000;

export interface SocksCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Reads exactly what the protocol asks for, one field at a time.
 *
 * A naive `once("data")` per message is the obvious way to write this and it is
 * wrong: TCP does not preserve message boundaries, so a greeting split across
 * two segments hangs and two messages in one segment lose the second. This cost
 * an afternoon in a throwaway version, so it is stated here.
 */
class FrameReader {
  #socket: net.Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #waiter: { need: number; resolve: (chunk: Buffer) => void } | null = null;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    // Annotated because a net.Socket's data is only a string once setEncoding
    // has been called, and nothing here ever does — the whole file is bytes.
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#settle();
    });
  }

  #settle(): void {
    const waiter = this.#waiter;
    if (waiter === null || this.#buffer.length < waiter.need) return;
    const chunk = this.#buffer.subarray(0, waiter.need);
    this.#buffer = this.#buffer.subarray(waiter.need);
    this.#waiter = null;
    waiter.resolve(chunk);
  }

  read(need: number): Promise<Buffer> {
    if (this.#waiter !== null) throw new Error("a read is already pending");
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        this.#waiter = null;
        reject(error);
      };
      this.#socket.once("error", fail);
      this.#socket.once("close", () => fail(new Error("client closed mid-negotiation")));
      this.#waiter = { need, resolve };
      this.#settle();
    });
  }

  /** Anything already buffered when the tunnel takes over. */
  drain(): Buffer {
    const rest = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return rest;
  }
}

export function generateCredentials(): SocksCredentials {
  const raw = randomBytes(24);
  return {
    username: raw.subarray(0, 12).toString("base64url"),
    password: raw.subarray(12).toString("base64url"),
  };
}

function matches(presented: Buffer, expected: string): boolean {
  const want = Buffer.from(expected, "utf8");
  if (presented.length !== want.length) return false;
  return timingSafeEqual(presented, want);
}

function reply(socket: net.Socket, code: number): void {
  // A bound address of 0.0.0.0:0. The client never uses it for CONNECT, and
  // reporting the netstack's real address would leak the tunnel's topology.
  socket.write(Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
}

export class SocksServer {
  #server: net.Server;
  #netstack: TunnelNetstack;
  #credentials: SocksCredentials;

  private constructor(server: net.Server, netstack: TunnelNetstack, credentials: SocksCredentials) {
    this.#server = server;
    this.#netstack = netstack;
    this.#credentials = credentials;
  }

  static async start(
    netstack: TunnelNetstack,
    credentials: SocksCredentials = generateCredentials(),
  ): Promise<SocksServer> {
    const server = net.createServer();
    const socks = new SocksServer(server, netstack, credentials);
    server.on("connection", (socket) => {
      void socks.#handle(socket).catch(() => socket.destroy());
    });
    // Loopback and an ephemeral port: nothing outside this process's network
    // namespace can reach a tunnel, and the api is told which port it got.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return socks;
  }

  get port(): number {
    return (this.#server.address() as net.AddressInfo).port;
  }

  get credentials(): SocksCredentials {
    return this.#credentials;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(socket: net.Socket): Promise<void> {
    socket.setTimeout(NEGOTIATION_TIMEOUT_MS, () => socket.destroy());
    const reader = new FrameReader(socket);

    if (!(await this.#authenticate(socket, reader))) return;

    const head = await reader.read(4);
    if (head.readUInt8(0) !== VERSION) throw new Error("not a socks5 request");
    if (head.readUInt8(1) !== CMD_CONNECT) {
      reply(socket, REPLY_COMMAND_UNSUPPORTED);
      socket.end();
      return;
    }

    const host = await this.#readAddress(reader, head.readUInt8(3));
    const port = (await reader.read(2)).readUInt16BE(0);

    let connection: Awaited<ReturnType<TunnelNetstack["connect"]>>;
    try {
      connection = await this.#netstack.connect(host, port);
    } catch (error) {
      // A refusal and an unreachable host are different answers, and the caller
      // can act on the difference: one is a misconfigured tunnel, the other is
      // a database that is down.
      const refused = (error as Error).name === "TunnelTargetError";
      reply(socket, refused ? REPLY_NOT_ALLOWED : REPLY_HOST_UNREACHABLE);
      socket.end();
      return;
    }

    reply(socket, REPLY_SUCCESS);
    // Negotiation is over; the connection now lives as long as the database
    // session does, so the deadline that bounded it must not bound that.
    socket.setTimeout(0);

    const writer = connection.writable.getWriter();
    // Anything the client pipelined behind its request belongs to the tunnel.
    const pipelined = reader.drain();
    if (pipelined.length > 0) await writer.write(pipelined);

    socket.on("data", (chunk: Buffer) => {
      void writer.write(chunk).catch(() => socket.destroy());
    });
    socket.on("close", () => void connection.close().catch(() => {}));
    socket.on("error", () => void connection.close().catch(() => {}));

    try {
      for await (const chunk of connection.readable) {
        if (!socket.write(chunk)) await new Promise((resolve) => socket.once("drain", resolve));
      }
    } catch {
      // The tunnel dropped; the client sees a closed socket, which is what a
      // dropped connection to a database looks like anyway.
    }
    socket.end();
  }

  async #authenticate(socket: net.Socket, reader: FrameReader): Promise<boolean> {
    const greeting = await reader.read(2);
    if (greeting.readUInt8(0) !== VERSION) throw new Error("not a socks5 greeting");
    const methods = await reader.read(greeting.readUInt8(1));

    // Username/password only. Loopback already bounds who can reach a listener
    // to processes in this network namespace — but the credential is what stops
    // one tunnel's port from being usable to reach another tenant's network if
    // that assumption ever stops holding, which for a multi-tenant control
    // plane is worth the twenty lines.
    if (!methods.includes(METHOD_USERPASS)) {
      socket.write(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]));
      socket.end();
      return false;
    }
    socket.write(Buffer.from([VERSION, METHOD_USERPASS]));

    const header = await reader.read(2);
    if (header.readUInt8(0) !== AUTH_VERSION) throw new Error("unsupported auth version");
    const username = await reader.read(header.readUInt8(1));
    const password = await reader.read((await reader.read(1)).readUInt8(0));

    // Both compared even when the first already failed, so the reply cannot be
    // timed to learn which half was wrong.
    const okUser = matches(username, this.#credentials.username);
    const okPass = matches(password, this.#credentials.password);
    if (!(okUser && okPass)) {
      socket.write(Buffer.from([AUTH_VERSION, 0x01]));
      socket.end();
      return false;
    }
    socket.write(Buffer.from([AUTH_VERSION, 0x00]));
    return true;
  }

  async #readAddress(reader: FrameReader, atyp: number): Promise<string> {
    if (atyp === ATYP_IPV4) return [...(await reader.read(4))].join(".");
    if (atyp === ATYP_IPV6) {
      const raw = await reader.read(16);
      const parts: string[] = [];
      for (let index = 0; index < 16; index += 2) parts.push(raw.readUInt16BE(index).toString(16));
      return parts.join(":");
    }
    if (atyp === ATYP_DOMAIN) {
      const length = (await reader.read(1)).readUInt8(0);
      return (await reader.read(length)).toString("utf8");
    }
    throw new Error(`unsupported address type ${atyp}`);
  }
}

export const SOCKS_REPLY = {
  SUCCESS: REPLY_SUCCESS,
  GENERAL_FAILURE: REPLY_GENERAL_FAILURE,
  NOT_ALLOWED: REPLY_NOT_ALLOWED,
  HOST_UNREACHABLE: REPLY_HOST_UNREACHABLE,
} as const;

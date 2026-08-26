import net from "node:net";
import { Duplex } from "node:stream";
import { SocksClient } from "socks";
import type { DialProxy } from "./ports";

// Turns a loopback SOCKS5 endpoint into the shape each driver's dial hook
// wants. Three engines, two shapes, and the difference is not cosmetic.
//
// Measured against real servers before any of this was written (mongod 7.0.39,
// PostgreSQL 18.6, SQL Server 2022 CU26): all three complete a dial through a
// SOCKS5 proxy, TLS included, and all three send the destination AS A HOSTNAME
// — SOCKS address type 3 on every dial. That last fact is what makes one tunnel
// shape serve every engine, because resolution then happens on the customer's
// side where a private replica set's member names mean something.

/** MongoDB takes SOCKS natively; these go straight into MongoClientOptions. */
export function mongoProxyOptions(proxy: DialProxy): {
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
} {
  return {
    proxyHost: proxy.host,
    proxyPort: proxy.port,
    proxyUsername: proxy.username,
    proxyPassword: proxy.password,
  };
}

/**
 * tedious's `options.connector`: hand back an already-connected socket.
 *
 * It is called with the destination up front, so a connect-on-create SOCKS
 * client drops straight in. Note the instance-name lookup that can precede it
 * speaks UDP 1434 on the HOST's network and would not be tunnelled — a
 * tunnelled SQL Server has to be addressed by port, not by instance name.
 */
export function mssqlConnector(
  proxy: DialProxy,
): (options: { host: string; port: number }) => Promise<net.Socket> {
  return async ({ host, port }) => {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        userId: proxy.username,
        password: proxy.password,
      },
      command: "connect",
      destination: { host, port },
    });
    return socket;
  };
}

/**
 * node-pg's `stream` factory, and the one that does not drop in.
 *
 * pg calls `stream.connect(port, host)` AFTER the factory returns, so the
 * destination is not known at construction time and a connect-on-create SOCKS
 * client cannot be used. Subclassing net.Socket to intercept that call was
 * tried and abandoned: it collides with node's own connect and read lifecycle
 * in ways that took an afternoon and never worked. A plain Duplex bridging to a
 * separately dialled socket does work, and `tls.connect({ socket })` accepts
 * any Duplex, so pg's TLS upgrade survives it — verified against a TLS-enabled
 * server, with pg_stat_ssl.ssl true through the tunnel.
 */
export function pgStreamFactory(proxy: DialProxy): () => Duplex {
  return () => new SocksStream(proxy);
}

class SocksStream extends Duplex {
  #proxy: DialProxy;
  #socket: net.Socket | null = null;
  #wantsRead = false;
  #failure: Error | null = null;

  constructor(proxy: DialProxy) {
    super();
    this.#proxy = proxy;
  }

  // pg calls these before it knows anything about the socket; they are the
  // socket's own concern once it exists, and no-ops here.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  connect(port: number, host: string): this {
    void SocksClient.createConnection({
      proxy: {
        host: this.#proxy.host,
        port: this.#proxy.port,
        type: 5,
        userId: this.#proxy.username,
        password: this.#proxy.password,
      },
      command: "connect",
      destination: { host, port },
    }).then(
      ({ socket }) => {
        if (this.#failure !== null) {
          socket.destroy();
          return;
        }
        this.#socket = socket;
        // pg attaches its parser SYNCHRONOUSLY inside the same connect() call
        // that starts this, so _read has already been asked for bytes with no
        // socket to ask. Without replaying that request here, node never calls
        // _read again and the connection hangs after the startup packet — the
        // single hardest bug in the spike that proved this shape.
        if (this.#wantsRead) socket.resume();
        else socket.pause();
        socket.on("data", (chunk: Buffer) => {
          if (this.push(chunk)) return;
          this.#wantsRead = false;
          socket.pause();
        });
        socket.on("end", () => this.push(null));
        socket.on("close", () => this.push(null));
        socket.on("error", (error) => this.destroy(error));
        this.emit("connect");
      },
      (error: Error) => this.destroy(error),
    );
    return this;
  }

  override _read(): void {
    this.#wantsRead = true;
    this.#socket?.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ): void {
    const socket = this.#socket;
    if (socket === null) {
      callback(new Error("wrote to the proxy before it was connected"));
      return;
    }
    // node's socket callback is (err?: Error | null); the stream's is
    // (error?: Error). Adapting rather than widening _write's signature keeps
    // the Duplex contract exactly as node states it.
    socket.write(chunk, (error) => callback(error ?? undefined));
  }

  override _final(callback: (error?: Error) => void): void {
    if (this.#socket === null) callback();
    else this.#socket.end(() => callback());
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.#failure = error ?? new Error("destroyed");
    this.#socket?.destroy();
    callback(error);
  }
}

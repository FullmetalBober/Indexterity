import { masterKeyBytesFor } from "../config/env";
import { type Database, envKeyProvider, eq, open as openSealed, tunnels } from "../db";
import type { TunnelRoute } from "../engine/net-guard";
import type { DialProxy } from "../engine/ports";
import { parseWireGuardConf } from "./conf";
import type { TunnelRegistry } from "./tunnel.registry";

// Cluster row's tunnel_id -> how the adapters reach it: a live SOCKS5 endpoint to
// dial through, AND the route every address must be judged against.
//
// Both, because the proxy alone only says where to dial. #382 is what one without
// the other cost: member discovery had the proxy and judged a replica set's
// private members with the direct guard, refusing all of them.
//
// Lazy, and that is the design. A tunnel is brought up the first time something
// needs it rather than at boot, so an api that restarts does not hold peerings
// open for clusters nobody is collecting, and a tenant whose gateway is down
// costs nothing until a job actually asks for it. The registry is idempotent,
// so asking twice returns the same endpoint rather than a second tunnel.

export class TunnelUnavailableError extends Error {
  constructor(
    readonly tunnelId: string,
    cause?: unknown,
  ) {
    super(`the tunnel this cluster is reached through could not be brought up`);
    this.name = "TunnelUnavailableError";
    this.cause = cause;
  }
}

export interface ClusterDialRoute {
  readonly proxy: DialProxy;
  readonly route: TunnelRoute;
}

/**
 * Null when the cluster is dialled directly, which is the common case and every
 * cluster that existed before #353.
 */
export async function routeForCluster(
  db: Database,
  tunnelId: string | null,
  registry: TunnelRegistry | undefined,
): Promise<ClusterDialRoute | null> {
  if (tunnelId === null) return null;

  // Undefined means the caller has no registry — a unit test, or a job entry
  // point that was never given one. Refused rather than defaulted: the
  // alternative to a tunnel is dialling the cluster's private addresses
  // directly over the open internet.
  if (registry === undefined) {
    throw new TunnelUnavailableError(tunnelId, new Error("no tunnel registry was provided"));
  }

  // Already up: the overwhelmingly common path once a cluster is being
  // collected on a schedule.
  const existing = registry.endpoint(tunnelId);
  if (existing !== null) {
    const route = registry.routeFor(tunnelId);
    // An endpoint with no route would mean the tunnel went away between those two
    // reads. Falling through re-opens it rather than dialling with half of what a
    // dial needs.
    if (route !== null) return { proxy: toProxy(existing), route };
  }

  const [row] = await db.select().from(tunnels).where(eq(tunnels.id, tunnelId)).limit(1);
  if (row === undefined) {
    // The FK is RESTRICT, so this means the row was removed out of band rather
    // than through the api. Refusing is right: the alternative is dialling the
    // cluster's private addresses directly, over the open internet.
    throw new TunnelUnavailableError(tunnelId, new Error("the tunnel row is gone"));
  }

  try {
    const conf = parseWireGuardConf(
      new TextDecoder().decode(
        await openSealed(
          { dek: row.sealedDek, data: row.sealedData },
          envKeyProvider(masterKeyBytesFor(row.keyVersion)),
        ),
      ),
    );
    const endpoint = await registry.open(tunnelId, conf);
    return {
      proxy: toProxy(endpoint),
      route: {
        allowedIps: [...conf.peer.allowedIps],
        resolve: (host) => registry.resolve(tunnelId, host),
      },
    };
  } catch (error) {
    throw new TunnelUnavailableError(tunnelId, error);
  }
}

function toProxy(endpoint: {
  host: string;
  port: number;
  credentials: { username: string; password: string };
}): DialProxy {
  return {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.credentials.username,
    password: endpoint.credentials.password,
  };
}

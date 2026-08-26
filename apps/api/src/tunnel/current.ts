import type { TunnelRegistry } from "./tunnel.registry";

// The one place the job pipeline can reach the live tunnels.
//
// This is a service locator, which is a smell, so here is the argument for it
// rather than a shrug.
//
// The pipeline is deliberately NOT dependency-injected — jobs/ is plain
// functions taking `db`, for the reason the wiki gives about analysis/ and the
// three adapters: injection pays for substitutability, lifecycle and
// interception, and a function with nothing to substitute gets none of the
// three. Threading a registry through collectCluster, applyCluster,
// buildingCluster, createCluster and probeCluster — five signatures and every
// call site — would be paying that price for a dependency that has exactly one
// instance and no alternative implementation.
//
// And it genuinely has one instance. #353 notes that the worker is embedded in
// the api process (main.ts), so one process owns every tunnel and there is no
// cross-process handoff to design. A second registry would not be a different
// configuration; it would be a bug.
//
// The cost is that a test wanting a fake tunnel has to set this, which is why
// setTunnelRegistry is exported rather than hidden. TunnelRegistry's
// constructor calls it, so nothing else has to remember to.

let registry: TunnelRegistry | null = null;

export function setTunnelRegistry(value: TunnelRegistry | null): void {
  registry = value;
}

/**
 * Null before the container has built the registry, and in any unit test that
 * did not ask for one. A caller must treat that as "no tunnel", not as an
 * error: a cluster with no tunnel_id is the overwhelmingly common case and must
 * not depend on this being wired.
 */
export function tunnelRegistry(): TunnelRegistry | null {
  return registry;
}

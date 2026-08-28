/**
 * Where the tunnel service is, and the secret to greet it with — one setting,
 * because an address and a token that can be configured apart can be configured
 * inconsistently, and the failure then shows up as a tunnel that will not come up
 * for a reason no screen names.
 *
 * `tcp://TOKEN@tunnel:9411` plain, `tcps://TOKEN@tunnel:9411` over TLS. Parsed
 * here rather than in the config schema so the schema can validate it at boot
 * with the same code that uses it at runtime: a URL that parses in one place and
 * not the other is the one failure mode a second parser buys.
 *
 * Absent means the VPN feature is off. That is a supported state, not a
 * misconfiguration — the dashboard says so rather than offering a form that
 * cannot work.
 */

export interface TunnelLink {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** tcps:// — the control connection is TLS, and so is what carries the key. */
  readonly tls: boolean;
}

export class TunnelUrlError extends Error {}

const SCHEMES = new Map<string, boolean>([
  ["tcp:", false],
  ["tcps:", true],
]);

export function parseTunnelUrl(raw: string): TunnelLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TunnelUrlError(`${raw} is not a URL — expected tcp://TOKEN@host:port`);
  }

  const tls = SCHEMES.get(url.protocol);
  if (tls === undefined) {
    throw new TunnelUrlError(
      `${url.protocol}// is not a tunnel scheme — expected tcp:// or tcps://`,
    );
  }
  if (url.hostname === "") throw new TunnelUrlError(`${raw} names no host`);
  if (url.port === "") throw new TunnelUrlError(`${raw} names no port`);

  // Both halves set is refused rather than resolved by precedence. `user:pass@`
  // means the operator thinks one of them is something other than the token, and
  // guessing which would authenticate with half of what they wrote.
  if (url.username !== "" && url.password !== "") {
    throw new TunnelUrlError(
      `${raw} carries both a username and a password — the token is one value, in either position`,
    );
  }
  const token = decodeURIComponent(url.password === "" ? url.username : url.password);
  if (token === "") {
    throw new TunnelUrlError(
      `${raw} carries no token — the service refuses a greeting without one, so this would never connect`,
    );
  }

  // Path, query and fragment are refused rather than ignored: this is a socket,
  // not an endpoint, and a `/v1` somebody added expecting it to matter would
  // silently not.
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new TunnelUrlError(`${raw} carries a path, and the tunnel service has none`);
  }

  return {
    // Bracketed IPv6 comes back bracketed from `hostname`; net.connect wants it
    // without, and it is the only host shape that differs.
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port),
    token,
    tls,
  };
}

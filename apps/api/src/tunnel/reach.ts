import type { DeviceState, TunnelDevice } from "./wireguard/device";

// "Would this tunnel actually work?", asked on purpose.
//
// A tunnel is registered by pasting a file, and everything that can be checked
// about a file has been checked by the time it is stored: conf.ts refuses a
// config that cannot work, naming the directive. What a file cannot tell anyone
// is whether the peer on the other end agrees — a mistyped PublicKey, a gateway
// that moved, a UDP port a firewall drops, a peering the VPN admin revoked all
// parse perfectly and all fail identically at the first collect, as a timeout
// somebody will read as a problem with their database.
//
// So this asks. It is deliberately not a function of the device's current
// state: a device sitting on a session negotiated an hour ago reports itself up
// and would keep doing so long after the gateway was switched off, because
// WireGuard has nothing to say until traffic needs a rekey. Only a handshake
// completed AFTER the owner pressed the button is evidence about now.

/**
 * How long to wait for the gateway to answer.
 *
 * A handshake is one round trip, so a reachable gateway answers in
 * milliseconds. The window is sized for the retry rather than the round trip:
 * the device re-sends its initiation every 5s (REKEY_TIMEOUT_MS), so this
 * covers the first attempt, one retry, and the second attempt's flight — enough
 * that a single dropped datagram does not read as "unreachable".
 *
 * It is NOT the device's own 90s give-up window. That is right for a collect
 * running unattended and far too long for somebody watching a button, and the
 * device keeps trying in the background either way, so a slow gateway shows up
 * as UP on the next refresh rather than as a lost result.
 */
export const REACH_TIMEOUT_MS = 8_000;

export interface Reachability {
  /** Did a handshake complete inside the window — did the gateway answer, now? */
  readonly reachable: boolean;
  readonly state: DeviceState;
  readonly handshakeAgeSeconds: number | null;
  /**
   * Why it did not answer, verbatim from the device, or null when it did — and
   * also null when the gateway simply stayed silent, which is what an
   * unreachable endpoint and a wrong PublicKey both look like from here. There
   * is no cause to report in that case and inventing one would send the owner
   * looking somewhere specific for a reason nobody has.
   */
  readonly error: string | null;
}

export async function probeReachability(
  device: TunnelDevice,
  timeoutMs: number = REACH_TIMEOUT_MS,
): Promise<Reachability> {
  // A holder rather than a plain `let`: assignments inside a listener are
  // invisible to the compiler's flow analysis, which would narrow the variable
  // back to null at the read below.
  const seen: { error: Error | null } = { error: null };
  const onError = (error: Error) => {
    seen.error = error;
  };

  let stopWatching = () => {};
  const answered = new Promise<boolean>((resolve) => {
    const onHandshake = () => resolve(true);
    device.on("handshake", onHandshake);
    stopWatching = () => {
      device.off("handshake", onHandshake);
    };
  });

  device.on("error", onError);
  try {
    // Errors here are the device's, reported as events, not thrown — a gateway
    // address the network guard refuses arrives on the error listener above.
    await device.handshake();
    const reachable = await Promise.race([answered, after(timeoutMs).then(() => false)]);
    return {
      reachable,
      state: device.state,
      handshakeAgeSeconds: device.handshakeAgeSeconds(),
      error: reachable ? null : (seen.error?.message ?? null),
    };
  } finally {
    stopWatching();
    device.off("error", onError);
  }
}

function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd: a probe in flight is not a reason to hold the process open at
    // shutdown, and the request it belongs to is what keeps the loop alive.
    setTimeout(resolve, ms).unref?.();
  });
}

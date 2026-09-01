// Repeating alerts (a cluster that has been unreachable for a week fails its
// collect every hour) become noise nobody reads. One per key per window.
//
// The window has to survive a process EXIT, which is what #212 changed. This
// was a module-level Map, on the argument that the worker is a single replica
// and a restart re-alerting once is the right failure mode. Burst mode is a
// whole process per tick: on a fifteen-minute cron that Map is empty 96 times a
// day, and a cluster unreachable since Tuesday would mail its owners 96 times.
// A restart re-alerting once is a fine failure mode; a restart every tick is
// not, so the claim moved to the same table the burst schedule uses — both are
// "claim this key if nothing has claimed it since T" (jobs/watermark.ts).
//
// Injected rather than reached for, so the rule below is testable without a
// database and so the caller decides what the claim is backed by.
export type ClaimStore = (key: string, notBefore: Date, now: Date) => Promise<boolean>;

// One alert per cluster+task per day, shared by both paths that raise them:
// a task that burned its last retry, and one that skipped because the cluster
// was unreachable.
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function alertAllowed(
  claim: ClaimStore,
  key: string,
  cooldownMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  return claim(key, new Date(now.getTime() - cooldownMs), now);
}

// How long a claim is held for when the mail it was taken for never reached a
// transport (#419).
//
// The cooldown above is a claim taken BEFORE the send, which is what keeps the
// concurrency story a single upsert with no lock: two ticks racing on the same
// key are serialised by postgres, and exactly one of them mails. The cost of
// that ordering is that a send which fails has already spent the day's alert —
// the mail was never delivered, `sendMail` swallows the fault, and the next tick
// is refused for 24 hours. A cluster that went unreachable at 09:00 and an SMTP
// server that was down at 09:00 produced the same silence.
//
// So a total failure hands most of the window back rather than releasing the
// claim outright: the claim stays taken, which is what stops a double mail, and
// its stamp is moved back so the NEXT occurrence of the same failure alerts
// again. Five minutes because that is the fastest pass cadence there is
// (`apply` and `probe`, jobs/schedule.ts) — the retry then lands on the next
// run of whatever failed rather than on a timer of its own, and an hourly pass
// retries hourly because that is when it next has something to say.
export const ALERT_RETRY_MS = 5 * 60 * 1000;

export interface AlertTiming {
  readonly cooldownMs?: number;
  readonly retryMs?: number;
  readonly now?: Date;
}

// The claim store's two halves, as the alert path needs them. `defer` is what
// makes a failed send a delayed alert instead of a lost one; jobs/watermark.ts
// backs both with the same table and the same key namespace.
export interface AlertClaims {
  readonly claim: ClaimStore;
  readonly defer: (key: string, at: Date) => Promise<void>;
}

// Whether an alert is SETTLED: whether a later attempt could do better than
// this one did.
//
// Its own function because the polarity is the whole of #419 and it is not
// obvious in either direction. Three of the four cases are settled without a
// mail having been delivered:
//
//   delivered > 0       the transport took at least one. Partial counts: sending
//                       again to reach the second of three owners re-mails the
//                       first two, and "nobody heard" has not happened.
//   attempted === 0     no owner rows. A retry finds the same empty list.
//   no transport        no SMTP on this deployment, so every send is a logged
//                       no-op and stays one until the environment changes.
//                       Retrying that every five minutes forever buys nothing.
//
// What is left — a configured transport that refused every send — is the one
// that gets the claim handed back.
export function alertSettled(
  attempted: number,
  delivered: number,
  transportConfigured: boolean,
): boolean {
  return delivered > 0 || attempted === 0 || !transportConfigured;
}

// Claim, send, and hand the claim back if nothing was sent — the whole alert
// rule, in the one place every alert goes through.
//
// A single function rather than the `alertAllowed` / `alertOwners` pair the
// tasks used to call in sequence, because the pair could be — and was — half
// used: five call sites claimed the window and then dropped whatever the send
// reported, so an SMTP fault consumed the day's alert for that key. There is no
// way to spell that mistake here, which is the point.
//
// `send` reports whether the alert is SETTLED, not whether a mail was sent: a
// cluster with no owner rows and a deployment with no SMTP at all have nothing
// for a retry to improve, and deferring on those would re-run the same no-op
// every five minutes forever. NotifyService.notifyClusterOwners answers exactly
// that question.
export async function raiseAlert(
  claims: AlertClaims,
  key: string,
  send: () => Promise<boolean>,
  // The two windows and the clock, so a test can name a moment. Every caller in
  // the app takes all three defaults — the constants above are the policy, and a
  // call site free to pick its own cooldown is a second policy nobody declared.
  { cooldownMs = ALERT_COOLDOWN_MS, retryMs = ALERT_RETRY_MS, now = new Date() }: AlertTiming = {},
): Promise<void> {
  if (!(await alertAllowed(claims.claim, key, cooldownMs, now))) return;
  if (await send()) return;
  // Stamped so that a claim made `retryMs` from now is the first one to succeed:
  // the compare-and-set asks `stored.at < now - cooldownMs`, so the stamp has to
  // be a full cooldown back from the moment the retry becomes due.
  await claims.defer(key, new Date(now.getTime() - cooldownMs + retryMs));
}

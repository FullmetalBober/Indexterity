import { createTransport, type Transporter } from "nodemailer";
import { workerEnv } from "../config/env";

// Outbound mail (invites, alerts). Configured entirely from SMTP_* env; with no
// SMTP_HOST, sending is a logged no-op so dev environments work without SMTP.
//
// A host with only half its credentials no longer lands here: it used to read as
// "mail is off" while every invitation and reset reported success, and the
// schema refuses to boot on it instead (config/schema.ts → checkMailGroup).
let transporter: Transporter | null | undefined;

// How long a send may spend on a server that is not answering, per phase.
//
// Stated rather than inherited, because nodemailer's defaults are two minutes to
// connect and no socket timeout at all, and this send is not a background job:
// better-auth awaits `sendVerificationEmail` INSIDE the sign-up request, so
// whatever the transport waits, the reader waits. Measured on the hosted deploy,
// where the platform drops outbound SMTP rather than refusing it — one
// `POST /sign-up/email` took 122.5 seconds, all of it a SYN going nowhere, and
// then succeeded, so the account existed and the browser had spent two minutes
// finding out. A dropped packet is the case that needs a number; a refused
// connection returns on its own.
//
// Ten seconds is far above what a reachable SMTP server takes to answer (Gmail
// answers in well under one) and far below the point where a reader assumes the
// page is broken. The socket gets longer because it covers the body transfer,
// not just a handshake.
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

// The ports where TLS starts at the first byte rather than after a STARTTLS
// command. Getting this wrong does not degrade, it hangs: a client that speaks
// plaintext EHLO into a TLS socket waits for a greeting that never comes, and
// the connection times out with nothing in the log about what was actually
// wrong.
//
// It is a set rather than `=== 465` because 465 is not the only one, and the
// others are precisely the ones a deployment here ends up on. A host that blocks
// the standard submission ports — Render's free tier blocks 25, 465 and 587 — is
// routed around by using the duplicate a provider offers on a high port, and
// those come in both flavours: Resend answers implicit TLS on 2465 and STARTTLS
// on 2587, SMTP2GO implicit on 8465 and STARTTLS on 2525. So the escape from a
// blocked port was also a coin flip on whether mail worked at all.
const IMPLICIT_TLS_PORTS = new Set([465, 2465, 8465]);

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass, SMTP_PORT: port } = workerEnv();
  if (host === undefined || user === undefined || pass === undefined) {
    transporter = null;
    return transporter;
  }
  transporter = createTransport({
    host,
    port,
    // Implicit TLS where the port says so, STARTTLS everywhere else — and
    // `requireTLS` is what makes that second half a guarantee rather than a
    // hope. Without it nodemailer upgrades only if the server volunteers
    // STARTTLS in its EHLO, so a server that does not, or a middlebox that
    // strips the line, gets this deployment's SMTP password in plaintext and
    // nothing says so. Ignored on the implicit ports, where the socket is
    // already TLS before a command is sent.
    secure: IMPLICIT_TLS_PORTS.has(port),
    requireTLS: true,
    auth: { user, pass },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
  return transporter;
}

export function mailEnabled(): boolean {
  return getTransporter() !== null;
}

// Best-effort send: alerts and invite mails must never fail the caller.
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const transport = getTransporter();
  if (transport === null) {
    console.warn(`mail disabled (no SMTP config); skipped "${subject}" to ${to}`);
    return false;
  }
  const { MAIL_FROM, SMTP_USER } = workerEnv();
  const from = MAIL_FROM ?? SMTP_USER ?? "";
  try {
    await transport.sendMail({ from: `Indexterity <${from}>`, to, subject, text });
    return true;
  } catch (error) {
    console.error(`mail send failed ("${subject}" to ${to}):`, error);
    return false;
  }
}

// The same send, not waited for. What every mail sent from inside a request
// somebody is sitting in front of should use.
//
// Sign-up is the case that named it. better-auth awaits `sendVerificationEmail`
// before it answers, so the reader's sign-up cost whatever the transport cost:
// 122.5 seconds on the hosted deploy, where the platform DROPS outbound SMTP
// rather than refusing it, and then a 200. The timeouts above cap that at ten
// seconds; this takes it out of the request altogether, so the account is
// created and the page is drawn while the transport is still dialling.
//
// Nothing is given up by not waiting, because there was never anything to wait
// FOR: `sendMail` swallows its own failures and resolves to a boolean that no
// caller has ever read — the contract at the top of this file, older than this
// function. What the caller learns by awaiting is nothing, at the price of
// everything the transport spends.
//
// A JOB that mails still awaits, and the difference is real: a task must not
// report success with its mail in flight, because the queue may have nothing
// else to run and the process is free to stop.
export function sendMailDetached(to: string, subject: string, text: string): void {
  // No `.catch` because `sendMail` cannot reject — it catches and logs inside.
  // If that ever changes, this is the line that turns a mail fault into an
  // unhandled rejection, so the two belong to each other.
  void sendMail(to, subject, text);
}

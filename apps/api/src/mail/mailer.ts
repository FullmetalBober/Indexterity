import { createTransport, type Transporter } from "nodemailer";
import { workerEnv } from "../config/env";

// Outbound mail (invites, alerts). Configured entirely from SMTP_* env; with no
// SMTP_HOST, sending is a logged no-op so dev environments work without SMTP.
//
// A host with only half its credentials no longer lands here: it used to read as
// "mail is off" while every invitation and reset reported success, and the
// schema refuses to boot on it instead (config/schema.ts → checkMailGroup).
let transporter: Transporter | null | undefined;

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
    secure: port === 465,
    auth: { user, pass },
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

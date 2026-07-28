import { createTransport, type Transporter } from "nodemailer";

// Outbound mail (invites, alerts). Configured entirely from SMTP_* env; when
// unset, sending is a logged no-op so dev environments work without SMTP.
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host === undefined || host === "" || user === undefined || pass === undefined) {
    transporter = null;
    return transporter;
  }
  const port = Number(process.env.SMTP_PORT ?? 465);
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
  const from = process.env.MAIL_FROM ?? process.env.SMTP_USER ?? "";
  try {
    await transport.sendMail({ from: `mongo-optimizer <${from}>`, to, subject, text });
    return true;
  } catch (error) {
    console.error(`mail send failed ("${subject}" to ${to}):`, error);
    return false;
  }
}

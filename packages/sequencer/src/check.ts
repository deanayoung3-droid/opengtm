import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { MailboxLogin } from "@opengtm/core";

export interface LoginCheck {
  prefix: string;
  user: string | null;
  smtp: string; // "ok" or the reason it failed
  imap: string;
  inboxMessages?: number;
}

export type LoginResult = Omit<LoginCheck, "prefix" | "user">;

/**
 * Log in to an SMTP/IMAP mailbox described by <PREFIX>_SMTP_* / <PREFIX>_IMAP_* settings without
 * sending anything: SMTP handshake + auth, then IMAP login and an INBOX count. Never returns secrets.
 */
export async function checkMailboxLogin(prefix: string, env: NodeJS.ProcessEnv): Promise<LoginCheck> {
  const user = env[`${prefix}_SMTP_USER`] ?? null;
  const pass = env[`${prefix}_SMTP_PASS`];
  if (!user || !pass) {
    const missing = `missing ${prefix}_SMTP_USER or ${prefix}_SMTP_PASS`;
    return { prefix, user, smtp: missing, imap: missing };
  }
  const r = await checkLogin({
    user,
    pass,
    smtpHost: env[`${prefix}_SMTP_HOST`] ?? "smtp.gmail.com",
    smtpPort: Number(env[`${prefix}_SMTP_PORT`] ?? 587),
    imapHost: env[`${prefix}_IMAP_HOST`] ?? "imap.gmail.com",
    imapPort: Number(env[`${prefix}_IMAP_PORT`] ?? 993),
  });
  return { prefix, user, ...r };
}

/** The same check for a login held in memory (bulk import). Sends nothing. */
export async function checkLogin(l: MailboxLogin): Promise<LoginResult> {
  const out: LoginResult = { smtp: "not checked", imap: "not checked" };
  try {
    await nodemailer
      .createTransport({ host: l.smtpHost, port: l.smtpPort, secure: l.smtpPort === 465, auth: { user: l.user, pass: l.pass }, connectionTimeout: 20_000 })
      .verify();
    out.smtp = "ok";
  } catch (err) {
    out.smtp = reason(err);
  }
  const client = new ImapFlow({ host: l.imapHost, port: l.imapPort, secure: l.imapPort === 993, auth: { user: l.user, pass: l.pass }, logger: false, connectionTimeout: 20_000 });
  client.on("error", () => undefined); // a socket timeout fails the check below instead of crashing the process
  try {
    await client.connect();
    const status = await client.status("INBOX", { messages: true });
    out.inboxMessages = status.messages;
    out.imap = "ok";
  } catch (err) {
    out.imap = reason(err);
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}

function reason(err: unknown): string {
  const e = err as { responseCode?: number; response?: string; message?: string; authenticationFailed?: boolean };
  if (e.responseCode === 535 || e.authenticationFailed) return "wrong address or app password (Google rejected the login)";
  return (e.response ?? e.message ?? String(err)).slice(0, 160);
}

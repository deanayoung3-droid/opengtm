import nodemailer, { type Transporter } from "nodemailer";
import { decryptLogin, type mailboxes } from "@opengtm/core";
import { buildMime, type OutgoingEmail } from "./headers";

type Mailbox = typeof mailboxes.$inferSelect;

export type SendErrorKind = "transient" | "throttle" | "auth" | "recipient" | "permanent";

export class SendError extends Error {
  constructor(
    message: string,
    readonly kind: SendErrorKind,
    readonly code?: string | number,
  ) {
    super(message);
  }
}

export interface MailTransport {
  send(e: OutgoingEmail): Promise<{ providerId?: string }>;
}

/** In-memory transport for tests and dry runs. */
export class FakeTransport implements MailTransport {
  sent: { email: OutgoingEmail; mime: string; at: Date }[] = [];
  failures: SendError[] = [];
  constructor(private now: () => Date = () => new Date()) {}
  async send(e: OutgoingEmail) {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push({ email: e, mime: (await buildMime(e)).toString("utf8"), at: this.now() });
    return { providerId: `fake-${this.sent.length}` };
  }
}

function classifySmtp(err: { responseCode?: number; code?: string; message?: string }): SendError {
  const rc = err.responseCode;
  const msg = err.message ?? "smtp error";
  if (rc === 535 || rc === 534 || rc === 530 || err.code === "EAUTH") return new SendError(msg, "auth", rc ?? err.code);
  if (rc === 421 || rc === 450 || rc === 451 || rc === 452) return new SendError(msg, /rate|limit|too many|throttl/i.test(msg) ? "throttle" : "transient", rc);
  if (rc === 550 || rc === 551 || rc === 553 || rc === 554) return new SendError(msg, /quota|limit|spam|block|policy/i.test(msg) ? "throttle" : "recipient", rc);
  if (err.code && ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(err.code)) return new SendError(msg, "transient", err.code);
  return new SendError(msg, "permanent", rc ?? err.code);
}

/** SMTP with username/password or app password (Google Workspace IMAP/SMTP mailboxes). */
export class SmtpTransport implements MailTransport {
  private t: Transporter;
  constructor(opts: { host: string; port: number; user: string; pass: string }) {
    this.t = nodemailer.createTransport({ host: opts.host, port: opts.port, secure: opts.port === 465, auth: { user: opts.user, pass: opts.pass } });
  }
  async send(e: OutgoingEmail) {
    try {
      const raw = await buildMime(e);
      const info = await this.t.sendMail({ envelope: { from: e.from.address, to: [e.to, ...(e.cc ?? [])] }, raw });
      return { providerId: info.messageId };
    } catch (err) {
      throw classifySmtp(err as { responseCode?: number; code?: string; message?: string });
    }
  }
}

function classifyHttp(status: number, body: string, who: string): SendError {
  if (status === 401 || status === 403) return new SendError(`${who} ${status}: ${body}`, "auth", status);
  if (status === 429) return new SendError(`${who} 429: ${body}`, "throttle", status);
  if (status >= 500) return new SendError(`${who} ${status}: ${body}`, "transient", status);
  return new SendError(`${who} ${status}: ${body}`, "permanent", status);
}

export type TokenSource = () => Promise<string>;

/** Cached OAuth2 refresh-token flow. Refresh failures with 400/401 are auth errors (credentials revoked). */
function cachedToken(refresh: () => Promise<Response>, who: string): TokenSource {
  let token: { value: string; exp: number } | null = null;
  return async () => {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    let res: Response;
    try {
      res = await refresh();
    } catch (err) {
      throw new SendError(`${who} token refresh failed: ${(err as Error).message}`, "transient");
    }
    if (!res.ok) throw classifyHttp(res.status === 400 ? 401 : res.status, await res.text(), who);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return token.value;
  };
}

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function googleTokenSource(c: GoogleCreds, fetchImpl: typeof fetch = fetch): TokenSource {
  return cachedToken(
    () =>
      fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }),
      }),
    "google oauth",
  );
}

export interface MicrosoftCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function microsoftTokenSource(c: MicrosoftCreds, fetchImpl: typeof fetch = fetch): TokenSource {
  return cachedToken(
    () =>
      fetchImpl(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: c.clientId,
          client_secret: c.clientSecret,
          refresh_token: c.refreshToken,
          scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read offline_access",
        }),
      }),
    "microsoft oauth",
  );
}

/** Gmail API users.messages.send with an OAuth refresh token. */
export class GmailApiTransport implements MailTransport {
  constructor(
    private token: TokenSource,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(e: OutgoingEmail) {
    const raw = (await buildMime(e)).toString("base64url");
    const res = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw classifyHttp(res.status, await res.text(), "gmail");
    const body = (await res.json()) as { id?: string };
    return { providerId: body.id };
  }
}

/** Microsoft Graph sendMail with MIME content and OAuth2 (no basic-auth SMTP). */
export class GraphTransport implements MailTransport {
  constructor(
    private token: TokenSource,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(e: OutgoingEmail) {
    const mime = (await buildMime(e)).toString("base64");
    const res = await this.fetchImpl("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "text/plain" },
      body: mime,
    });
    if (res.status !== 202 && !res.ok) throw classifyHttp(res.status, await res.text(), "graph");
    return {};
  }
}

export class MissingCredentialsError extends Error {}

function envNeed(mb: Mailbox, env: NodeJS.ProcessEnv) {
  const p = mb.credentialsEnv;
  if (!p) throw new MissingCredentialsError(`mailbox ${mb.email} has no credentials_env`);
  return (k: string) => {
    const v = env[`${p}_${k}`];
    if (!v) throw new MissingCredentialsError(`missing ${p}_${k} for ${mb.email}`);
    return v;
  };
}

export function googleCredsFromEnv(mb: Mailbox, env: NodeJS.ProcessEnv): GoogleCreds {
  const need = envNeed(mb, env);
  return { clientId: need("GOOGLE_CLIENT_ID"), clientSecret: need("GOOGLE_CLIENT_SECRET"), refreshToken: need("GOOGLE_REFRESH_TOKEN") };
}

export function microsoftCredsFromEnv(mb: Mailbox, env: NodeJS.ProcessEnv): MicrosoftCreds {
  const need = envNeed(mb, env);
  return { tenantId: need("MS_TENANT_ID"), clientId: need("MS_CLIENT_ID"), clientSecret: need("MS_CLIENT_SECRET"), refreshToken: need("MS_REFRESH_TOKEN") };
}

/** Build the transport for a mailbox from env vars named by its credentials_env prefix. */
export function transportFor(mb: Mailbox, env: NodeJS.ProcessEnv, fake?: MailTransport): MailTransport {
  if (mb.transport === "fake") {
    if (!fake) throw new MissingCredentialsError(`mailbox ${mb.email} uses the fake transport but none was provided`);
    return fake;
  }
  // Imported on Channels: the login is stored encrypted on the mailbox row.
  if (mb.transport === "smtp" && mb.credentialsEnc) {
    const l = decryptLogin(mb.credentialsEnc, env);
    return new SmtpTransport({ host: l.smtpHost, port: l.smtpPort, user: l.user, pass: l.pass });
  }
  const p = mb.credentialsEnv;
  if (!p) throw new MissingCredentialsError(`mailbox ${mb.email} has no credentials_env`);
  const need = (k: string) => {
    const v = env[`${p}_${k}`];
    if (!v) throw new MissingCredentialsError(`missing ${p}_${k} for ${mb.email}`);
    return v;
  };
  switch (mb.transport) {
    case "gmail_api":
      return new GmailApiTransport(googleTokenSource(googleCredsFromEnv(mb, env)));
    case "graph":
      return new GraphTransport(microsoftTokenSource(microsoftCredsFromEnv(mb, env)));
    case "smtp":
      return new SmtpTransport({ host: need("SMTP_HOST"), port: Number(env[`${p}_SMTP_PORT`] ?? 587), user: need("SMTP_USER"), pass: need("SMTP_PASS") });
  }
}

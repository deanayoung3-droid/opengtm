import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { decryptLogin, type mailboxes } from "@opengtm/core";
import {
  googleCredsFromEnv,
  googleTokenSource,
  microsoftCredsFromEnv,
  microsoftTokenSource,
  MissingCredentialsError,
  SendError,
  type TokenSource,
} from "./transports";

type Mailbox = typeof mailboxes.$inferSelect;

export interface InboundMessage {
  /** Provider-side id (IMAP UID, Gmail id, Graph id), for logging. */
  uid: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  subject: string;
  text: string;
  date: Date;
  /** Lowercased header names -> first value as text. */
  headers: Record<string, string>;
  contentType: string;
  /** Text of attached parts such as message/delivery-status and rfc822 headers (for DSNs). */
  attachmentsText: string[];
}

export interface MailReader {
  /** Messages newer than the cursor, plus the next cursor to store. */
  fetchNew(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string | null }>;
}

function addrList(a: ParsedMail["to"]): string[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((x) => x.value.map((v) => (v.address ?? "").toLowerCase())).filter(Boolean);
}

export async function parseRaw(raw: Buffer | string, uid: string): Promise<InboundMessage> {
  const p = await simpleParser(raw);
  const headers: Record<string, string> = {};
  for (const [k, v] of p.headers) {
    if (headers[k] !== undefined) continue;
    headers[k] = typeof v === "string" ? v : v && typeof v === "object" && "text" in v ? String((v as { text: string }).text) : v && typeof v === "object" && "value" in v ? String((v as { value: unknown }).value) : String(v);
  }
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const ct = p.headers.get("content-type");
  const contentType = ct && typeof ct === "object" && "value" in ct ? `${(ct as { value: string }).value}; ${Object.entries((ct as { params?: Record<string, string> }).params ?? {}).map(([k, v]) => `${k}=${v}`).join("; ")}` : String(ct ?? "");
  return {
    uid,
    rfcMessageId: p.messageId ?? null,
    inReplyTo: p.inReplyTo ?? null,
    references: refs,
    from: (p.from?.value[0]?.address ?? "").toLowerCase() || (p.from?.text ?? ""),
    to: addrList(p.to),
    subject: p.subject ?? "",
    text: (p.text ?? "").slice(0, 50_000),
    date: p.date ?? new Date(),
    headers,
    contentType,
    attachmentsText: p.attachments
      .filter((a) => /delivery-status|rfc822|text\//i.test(a.contentType))
      .map((a) => a.content.toString("utf8").slice(0, 20_000)),
  };
}

/** IMAP (password/app password). Cursor = "<uidvalidity>:<last uid>". */
export class ImapReader implements MailReader {
  constructor(private opts: { host: string; port: number; user: string; pass: string; mailbox?: string }) {}

  async fetchNew(cursor: string | null) {
    const client = new ImapFlow({ host: this.opts.host, port: this.opts.port, secure: this.opts.port === 993, auth: { user: this.opts.user, pass: this.opts.pass }, logger: false, connectionTimeout: 30_000 });
    // A dropped or timed-out connection is emitted as an 'error' event; with no listener Node crashes the whole
    // process (web and worker). With a listener the pending command fails instead, and ingest retries this mailbox.
    client.on("error", () => undefined);
    await client.connect();
    const out: InboundMessage[] = [];
    let next = cursor;
    try {
      const lock = await client.getMailboxLock(this.opts.mailbox ?? "INBOX");
      try {
        const status = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
        const validity = String(status?.uidValidity ?? "0");
        const [cv, cu] = (cursor ?? "").split(":");
        const lastUid = cv === validity ? Number(cu ?? 0) : 0;
        let maxUid = lastUid;
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= lastUid || !msg.source) continue;
          out.push(await parseRaw(msg.source, String(msg.uid)));
          maxUid = Math.max(maxUid, msg.uid);
        }
        next = `${validity}:${maxUid}`;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return { messages: out, cursor: next };
  }
}

/** Gmail API. Cursor = epoch ms of the newest message seen. */
export class GmailApiReader implements MailReader {
  constructor(
    private token: TokenSource,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  private async get(url: string) {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401 || res.status === 403) throw new SendError(`gmail read ${res.status}`, "auth", res.status);
    if (!res.ok) throw new SendError(`gmail read ${res.status}`, "transient", res.status);
    return res.json() as Promise<any>;
  }
  async fetchNew(cursor: string | null) {
    const since = Number(cursor ?? Date.now() - 2 * 86_400_000);
    const q = encodeURIComponent(`in:inbox after:${Math.floor(since / 1000)}`);
    const list = await this.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100`);
    const out: InboundMessage[] = [];
    let max = since;
    for (const { id } of (list.messages ?? []) as { id: string }[]) {
      const m = await this.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`);
      const internal = Number(m.internalDate ?? 0);
      if (internal <= since) continue;
      out.push(await parseRaw(Buffer.from(m.raw, "base64url"), id));
      max = Math.max(max, internal);
    }
    return { messages: out, cursor: String(max) };
  }
}

/** Microsoft Graph. Cursor = ISO receivedDateTime of the newest message seen. */
export class GraphReader implements MailReader {
  constructor(
    private token: TokenSource,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  private async req(url: string) {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401 || res.status === 403) throw new SendError(`graph read ${res.status}`, "auth", res.status);
    if (res.status === 429) throw new SendError("graph read throttled", "throttle", 429);
    if (!res.ok) throw new SendError(`graph read ${res.status}`, "transient", res.status);
    return res;
  }
  async fetchNew(cursor: string | null) {
    const since = cursor ?? new Date(Date.now() - 2 * 86_400_000).toISOString();
    const url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime gt ${since}&$orderby=receivedDateTime asc&$top=50&$select=id,receivedDateTime`;
    const list = (await (await this.req(url)).json()) as { value: { id: string; receivedDateTime: string }[] };
    const out: InboundMessage[] = [];
    let max = since;
    for (const m of list.value) {
      const raw = Buffer.from(await (await this.req(`https://graph.microsoft.com/v1.0/me/messages/${m.id}/$value`)).arrayBuffer());
      out.push(await parseRaw(raw, m.id));
      if (m.receivedDateTime > max) max = m.receivedDateTime;
    }
    return { messages: out, cursor: max };
  }
}

/** Scripted reader for tests. */
export class FakeReader implements MailReader {
  queue: InboundMessage[] = [];
  async fetchNew(cursor: string | null) {
    const messages = this.queue.splice(0);
    return { messages, cursor: String(Number(cursor ?? 0) + messages.length) };
  }
}

export function readerFor(mb: Mailbox, env: NodeJS.ProcessEnv, fake?: MailReader): MailReader {
  if (mb.transport === "fake") {
    if (!fake) throw new MissingCredentialsError(`mailbox ${mb.email} uses the fake transport but no reader was provided`);
    return fake;
  }
  if (mb.transport === "gmail_api") return new GmailApiReader(googleTokenSource(googleCredsFromEnv(mb, env)));
  if (mb.transport === "graph") return new GraphReader(microsoftTokenSource(microsoftCredsFromEnv(mb, env)));
  if (mb.credentialsEnc) {
    const l = decryptLogin(mb.credentialsEnc, env);
    return new ImapReader({ host: l.imapHost, port: l.imapPort, user: l.user, pass: l.pass });
  }
  const p = mb.credentialsEnv;
  const host = p && env[`${p}_IMAP_HOST`];
  if (!p || !host) throw new MissingCredentialsError(`missing ${p}_IMAP_HOST for ${mb.email}`);
  return new ImapReader({ host, port: Number(env[`${p}_IMAP_PORT`] ?? 993), user: env[`${p}_SMTP_USER`] ?? mb.email, pass: env[`${p}_SMTP_PASS`] ?? "" });
}

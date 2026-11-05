import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { unsubscribeToken } from "@opengtm/core";

export interface OutgoingEmail {
  from: { name: string; address: string };
  replyTo: string;
  to: string;
  /** Copied recipients (replies only), e.g. the real person behind a sender persona. */
  cc?: string[];
  subject: string;
  text: string;
  /** HTML alternative: internal mail, and outreach/replies whose signature shows the logo. The text part always goes too. */
  html?: string;
  /** Images inside the message (the signature logo), referenced from the HTML as cid:...; never fetched from a server. */
  inline?: { cid: string; filename: string; contentType: string; base64: string }[];
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  listUnsubscribe: { mailto: string; url?: string };
}

export function newMessageId(senderAddress: string): string {
  const domain = senderAddress.split("@")[1] ?? "localhost";
  return `<${randomUUID()}@${domain}>`;
}

export function listUnsubscribe(opts: { mailbox: string; contactId: string; baseUrl?: string; secret?: string }): OutgoingEmail["listUnsubscribe"] {
  const mailto = `mailto:${opts.mailbox}?subject=unsubscribe`;
  if (!opts.baseUrl || !opts.secret) return { mailto };
  return { mailto, url: `${opts.baseUrl.replace(/\/$/, "")}/u/${unsubscribeToken(opts.contactId, opts.secret)}` };
}

/** Header map, exposed separately so tests (and seed tests) can assert on it. */
export function buildHeaders(e: OutgoingEmail): Record<string, string> {
  const h: Record<string, string> = {
    "List-Unsubscribe": e.listUnsubscribe.url ? `<${e.listUnsubscribe.url}>, <${e.listUnsubscribe.mailto}>` : `<${e.listUnsubscribe.mailto}>`,
  };
  // One-click (RFC 8058) is only valid with an https URI.
  if (e.listUnsubscribe.url?.startsWith("https://")) h["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return h;
}

/** RFC 5322 message: plain text, plus an HTML alternative when given (logo embedded inline). No tracking, no remote images. */
export async function buildMime(e: OutgoingEmail): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: e.from.name, address: e.from.address },
    replyTo: e.replyTo,
    to: e.to,
    ...(e.cc?.length ? { cc: e.cc } : {}),
    subject: e.subject,
    text: e.text,
    ...(e.html ? { html: e.html } : {}),
    ...(e.html && e.inline?.length
      ? { attachments: e.inline.map((i) => ({ cid: i.cid, filename: i.filename, contentType: i.contentType, content: Buffer.from(i.base64, "base64"), contentDisposition: "inline" as const })) }
      : {}),
    messageId: e.messageId,
    inReplyTo: e.inReplyTo,
    references: e.references,
    headers: buildHeaders(e),
    textEncoding: "quoted-printable",
  });
  return new Promise((resolve, reject) => composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
}

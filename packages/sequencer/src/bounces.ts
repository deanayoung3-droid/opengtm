import type { InboundMessage } from "./readers";

export interface BounceInfo {
  kind: "hard" | "soft";
  status: string | null;
  recipient: string | null;
  originalMessageId: string | null;
  diagnostic: string;
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery subsystem|microsoftexchange)/i;
const BOUNCE_SUBJECT = /(undeliverable|undelivered mail|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery (failed|failure|subsystem)|could not be delivered|delivery incomplete)/i;
const HARD_TEXT = /(does not exist|user unknown|no such (user|mailbox|recipient)|address rejected|recipient (address )?rejected|mailbox (unavailable|not found)|recipient not found|invalid recipient|unknown recipient|address not found|account (has been )?disabled|5\.1\.[0-9])/i;

export function isBounce(m: InboundMessage): boolean {
  if (/report-type="?delivery-status/i.test(m.contentType)) return true;
  return BOUNCE_FROM.test(m.from) && BOUNCE_SUBJECT.test(m.subject);
}

/**
 * Parse a DSN (RFC 3464) or a non-standard bounce. 5.x.x is hard, 4.x.x is soft.
 * Without a status code, wording like "user unknown" counts as hard.
 */
export function parseBounce(m: InboundMessage): BounceInfo {
  const all = [m.text, ...m.attachmentsText].join("\n");
  const status = all.match(/^\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1] ?? all.match(/\b([45]\.\d\.\d{1,3})\b/)?.[1] ?? null;
  const recipient =
    all.match(/^\s*Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im)?.[1] ??
    all.match(/^\s*Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/im)?.[1] ??
    m.headers["x-failed-recipients"] ??
    null;
  const originalMessageId = all.match(/^\s*Message-ID:\s*(<[^>]+>)/im)?.[1] ?? m.inReplyTo ?? m.references.at(-1) ?? null;
  const diagnostic = (all.match(/^\s*Diagnostic-Code:\s*(.+)$/im)?.[1] ?? m.subject).slice(0, 300);
  let kind: "hard" | "soft";
  if (status) kind = status.startsWith("5") ? "hard" : "soft";
  else kind = HARD_TEXT.test(all) ? "hard" : "soft";
  return { kind, status, recipient: recipient?.toLowerCase() ?? null, originalMessageId, diagnostic };
}

const OOO_SUBJECT = /(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|away from (the |my )?(office|desk)|on (vacation|leave|holiday)|ooo\b)/i;

/** True for auto-responders (out of office, vacation replies). These never stop a sequence on their own. */
export function isAutoReply(m: InboundMessage): boolean {
  const auto = (m.headers["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (m.headers["x-autoreply"] || m.headers["x-autorespond"] || m.headers["x-auto-response-suppress"]?.match(/oof|all/i)) return true;
  if (/auto_reply|auto-reply/i.test(m.headers["precedence"] ?? "")) return true;
  return OOO_SUBJECT.test(m.subject);
}

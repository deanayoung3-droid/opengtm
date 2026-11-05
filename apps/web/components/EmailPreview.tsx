import type { Config } from "@opengtm/core";
import { previewHtml } from "@opengtm/writer";

type Sender = { senderName: string; senderTitle: string | null; senderPhone: string | null } | null | undefined;

/**
 * An email as the lead sees it: the words, the sending mailbox's current signature with the company
 * logo, and the footer. Shown like a mail app, light or dark with the dashboard. Falls back to plain text when there is no
 * mailbox yet or the body has no footer (e.g. a reply someone is still typing).
 */
export function EmailPreview({ body, mailbox, config }: { body: string; mailbox: Sender; config: Config }) {
  const html = mailbox ? previewHtml(body, config, { name: mailbox.senderName, title: mailbox.senderTitle, phone: mailbox.senderPhone }) : null;
  if (!html) return <pre className="email">{body}</pre>;
  // Built by previewHtml from escaped text and mailbox fields; the logo is an embedded image.
  return <div className="email-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

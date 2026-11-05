import { TEAM_TZ } from "./clock";
import { APP_NAME } from "./brand";
import type { InlineImage } from "./alerts";
import { REPLY_LABEL_NAMES, replyGist } from "./text";

/**
 * The email a teammate gets when a lead replies: who replied, a tag for what
 * kind of reply it is, only the words they wrote, what the app already did, the drafted answer, and
 * one button to the conversation. Plain-text version included for clients that don't show HTML.
 */
export interface ReplyEmailInput {
  person: { firstName: string | null; lastName: string | null; title: string | null; email: string };
  company: string | null;
  reply: { body: string; label: string | null; hot: boolean; summary: string | null; draftBody: string | null; autoSendAt: Date | null };
  /** They were already a hot lead in this conversation: this is a follow-up, not a new hot lead. */
  again?: boolean;
  link: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const para = (s: string) => esc(s).replace(/\n{2,}/g, "</p><p style=\"margin:0 0 10px 0;\">").replace(/\n/g, "<br>");

/** Our drafted answer without the sign-off and footer. */
const draftOnly = (draft: string) => draft.split(/\n(?:Best,|--)\n/)[0]!.trim();


export function replyEmail(i: ReplyEmailInput): { subject: string; text: string; html: string; inline: InlineImage[] } {
  const name = [i.person.firstName, i.person.lastName].filter(Boolean).join(" ") || i.person.email;
  const at = i.company ? ` from ${i.company}` : "";
  const gist = replyGist(i.reply.body, { first: i.person.firstName, last: i.person.lastName }) || "(no message text)";
  const tag = i.again ? "Follow-up" : i.reply.hot ? "Hot lead" : (REPLY_LABEL_NAMES[i.reply.label ?? ""] ?? "New reply");
  const short = gist.replace(/\s+/g, " ");
  const subject = `${i.reply.hot && !i.again ? "🔥 " : ""}${name}${i.company ? ` at ${i.company}` : ""} replied${i.again ? " again" : ""}: “${short.length > 48 ? `${short.slice(0, 46).replace(/\s+\S*$/, "")}…` : short}”`;
  const sendsAt = i.reply.autoSendAt ? i.reply.autoSendAt.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ }) : null;
  const did = i.reply.hot
    ? "A reply with the free preview and your booking link is drafted. Hot leads always wait for you."
    : sendsAt
      ? `A reply is drafted. It sends by itself ${sendsAt} PT unless you edit, send or hold it.`
      : i.reply.draftBody
        ? "A reply is drafted and waiting for you."
        : (i.reply.summary ?? "");
  const draft = i.reply.draftBody ? draftOnly(i.reply.draftBody) : "";
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  const accent = i.reply.hot ? "#e8641f" : "#2563eb";
  const button = i.reply.hot ? "Reply now" : "Open the conversation";
  const role = [i.person.title, i.company].filter(Boolean).join(" · ");

  const text = [
    `${name}${at} just replied${i.reply.hot ? " (hot lead)" : ` (${tag})`}.`,
    "",
    `"${gist}"`,
    "",
    i.reply.summary ? `In short: ${i.reply.summary}` : "",
    did,
    draft ? `\nDrafted reply:\n${draft}` : "",
    i.link ? `\n${button}: ${i.link}` : "",
    `\n--\nYou get these because of your email settings in ${APP_NAME} (Settings > Email notifications).`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 4px 14px 4px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:15px;font-weight:700;color:#18181b;letter-spacing:-0.01em;">${esc(APP_NAME)}</td>
</tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:26px 26px 24px 26px;">
<span style="display:inline-block;font-size:12px;font-weight:600;color:${accent};background:${i.reply.hot ? "#fff4ed" : "#eff6ff"};border-radius:999px;padding:3px 10px;">${i.reply.hot ? "🔥 " : ""}${esc(tag)}</span>
<h1 style="margin:12px 0 18px 0;font-size:22px;line-height:29px;font-weight:700;color:#0a0a0a;">${esc(name)}${esc(at)} ${i.again ? "replied again" : "just replied"}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececef;border-radius:12px;">
<tr><td style="padding:16px 18px 6px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:40px;height:40px;border-radius:20px;background:${i.reply.hot ? "#fff4ed" : "#eff6ff"};color:${accent};font-size:14px;font-weight:700;text-align:center;line-height:40px;">${esc(initials)}</td>
<td style="padding-left:12px;"><div style="font-size:15px;font-weight:600;color:#0a0a0a;">${esc(name)}</div>${role ? `<div style="font-size:13px;color:#71717a;margin-top:2px;">${esc(role)}</div>` : ""}</td>
</tr></table>
</td></tr>
<tr><td style="padding:10px 18px 16px 18px;">
<div style="border-left:3px solid ${accent};padding:2px 0 2px 14px;font-size:16px;line-height:24px;color:#18181b;"><p style="margin:0 0 10px 0;">${para(gist)}</p></div>
</td></tr>
</table>
${did ? `<p style="margin:18px 0 0 0;font-size:14px;line-height:21px;color:#3f3f46;">${i.reply.summary && !i.reply.hot ? `<b style="color:#18181b;">In short:</b> ${esc(i.reply.summary)}<br>` : ""}${esc(did)}</p>` : ""}
${draft ? `<div style="margin:16px 0 0 0;background:#fafafa;border:1px solid #ececef;border-radius:10px;padding:14px 16px;"><div style="font-size:12px;font-weight:600;color:#71717a;margin-bottom:6px;">Drafted reply</div><div style="font-size:14px;line-height:21px;color:#3f3f46;"><p style="margin:0 0 10px 0;">${para(draft.length > 700 ? `${draft.slice(0, 700)}…` : draft)}</p></div></div>` : ""}
${i.link ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr><td style="background:${i.reply.hot ? accent : "#0a0a0a"};border-radius:9px;"><a href="${esc(i.link)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${button} &rarr;</a></td></tr></table>` : ""}
</td></tr>
<tr><td style="padding:16px 6px 0 6px;font-size:12px;line-height:18px;color:#a1a1aa;">${i.reply.hot ? "Hot leads cool off fast. Replying within the hour works best. " : ""}You get these because of your email settings in ${esc(APP_NAME)} (Settings &rarr; Email notifications).</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject: subject.slice(0, 180), text, html, inline: [] };
}

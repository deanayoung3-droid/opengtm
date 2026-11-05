import { handleUnsubscribe, verifyUnsubscribeToken } from "@opengtm/core";
import { rt } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

const page = (title: string, body: string, status = 200) => {
  const company = escapeHtml(rt().ctx.config.business.company.name);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;font:15px/1.6 -apple-system,"Segoe UI",Inter,Roboto,sans-serif;color:#181d27;background:#f9fafe;-webkit-font-smoothing:antialiased}main{width:100%;max-width:440px;background:#fff;border-radius:14px;box-shadow:0 1px 2px rgba(10,13,18,.05),0 0 0 1px #e9eaeb;padding:32px}.mark{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:-.02em;margin-bottom:24px}.mark svg{width:18px;height:16px}h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px;line-height:1.25}p{color:#535862;margin:0 0 16px}button{font:600 14px/1 inherit;height:40px;padding:0 18px;border-radius:10px;border:0;background:#0a0d12;color:#fff;cursor:pointer}button:hover{opacity:.88}@media(prefers-color-scheme:dark){body{background:#0c0e12;color:#f7f7f7}main{background:#13161b;box-shadow:0 0 0 1px #22262f}p{color:#94979c}.mark path{fill:#f7f7f7}button{background:#f7f7f7;color:#0a0d12}}</style></head>
<body><main><div class="mark">${company}</div><h1>${title}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const companyName = () => escapeHtml(rt().ctx.config.business.company.name);

function contactFrom(token: string): string | null {
  return verifyUnsubscribeToken(token, process.env.UNSUBSCRIBE_SECRET ?? "");
}

/** Link clicks land here: confirm with one button (avoids link scanners unsubscribing people). */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!contactFrom(token)) return page("Link not recognized", "<p>This unsubscribe link is invalid. Reply “stop” to any of our emails and we will remove you.</p>", 404);
  return page(
    `Unsubscribe from ${companyName()} emails`,
    `<form method="post"><p>Click below and you will not receive further emails from us.</p><button type="submit">Unsubscribe</button></form>`,
  );
}

/** RFC 8058 one-click (mail clients POST "List-Unsubscribe=One-Click") and the confirm button both land here. */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const contactId = contactFrom(token);
  if (!contactId) return page("Link not recognized", "<p>This unsubscribe link is invalid.</p>", 404);
  await handleUnsubscribe(rt().ctx.db, contactId, "list-unsubscribe");
  return page("You're unsubscribed", `<p>You will not receive further emails from ${companyName()}. Sorry for the interruption.</p>`);
}

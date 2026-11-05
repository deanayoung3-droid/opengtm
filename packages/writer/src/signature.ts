import type { BrandLogos, Config } from "@opengtm/core";
import { composeBody, hasFooter, SIGNATURE_START, stripFooter, type SenderIdentity } from "./compliance";

/** An image carried inside the email (referenced as cid:...), so nothing is fetched when it is opened. */
export type { InlineImage } from "@opengtm/core";
import type { InlineImage } from "@opengtm/core";

export const LOGO_CID = "brand-logo";
export const LOGO_DARK_CID = "brand-logo-dark";

/** Greys and blue that read on a white and on a dark background, so the mail app's own text colour does the rest. */
const MUTED = "#8a8a8a";
const LINK = "#1a73e8";

/**
 * Lets mail apps in dark mode show the email dark instead of on a white rectangle, and swap in the white
 * logo when there is one (Apple Mail, iOS Mail, Outlook). Apps that ignore this keep the regular logo.
 */
const DARK_MODE_CSS =
  ":root{color-scheme:light dark;supported-color-schemes:light dark}" +
  "@media (prefers-color-scheme:dark){.brand-logo-light{display:none!important}.brand-logo-dark{display:block!important;max-height:none!important}}" +
  "[data-ogsc] .brand-logo-light{display:none!important}[data-ogsc] .brand-logo-dark{display:block!important;max-height:none!important}";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A line of the email as HTML, with web addresses clickable: full links (the booking link in a reply) and
 * our own site written bare, like "example.com" (company.site). Email addresses stay plain. Cold emails
 * carry no links at all (the checker rejects them), so this only ever touches replies.
 */
const URL_PART = String.raw`(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)'])`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Full URLs, plus the bare site host (not inside an email address or a longer name). */
const linkPattern = (siteHost: string | null) =>
  new RegExp(siteHost ? `${URL_PART}|(?<![\\w@./-])(${escapeRe(siteHost)})(?![\\w/@-])` : URL_PART, "gi");
const hostOf = (site: string) => {
  try {
    return new URL(site).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const linkLine = (line: string, links: RegExp) => {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(links)) {
    out += esc(line.slice(last, m.index));
    const href = m[1] ?? `https://${m[2]!.toLowerCase()}`;
    out += `<a href="${esc(href)}" style="color:${LINK}">${esc(m[0])}</a>`;
    last = m.index! + m[0].length;
  }
  return out + esc(line.slice(last));
};
const paragraphs = (text: string, links: RegExp) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.split("\n").map((l) => linkLine(l, links)).join("<br>")}</p>`)
    .join("");

/**
 * The signature as Gmail shows a team member's: "--", bold name, "Title | C: phone", and the company logo
 * when one is set. No colours on the name or title, so they follow the mail app's light or dark text.
 * `mode` is "cid" in a sent email and "data" in the dashboard.
 */
export function signatureHtml(sender: SenderIdentity, config: Pick<Config, "logos" | "business">, mode: "cid" | "data" = "cid"): string {
  const title = sender.title?.trim();
  const phone = sender.phone?.trim();
  const call = phone ? `C: <a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}" style="color:${LINK}">${esc(phone)}</a>` : "";
  const role = [title ? esc(title) : "", call].filter(Boolean).join(" | ");
  const { light, dark } = config.logos;
  const alt = esc(config.business.company.name);
  const src = (cid: string, b64: string) => (mode === "cid" ? `cid:${cid}` : `data:image/png;base64,${b64}`);
  const img = (cls: string, cid: string, b64: string, hidden: boolean) =>
    `<img class="${cls}" src="${src(cid, b64)}" alt="${alt}" height="30" style="${hidden ? "display:none;max-height:0;overflow:hidden;mso-hide:all;" : "display:block;"}height:30px;width:auto;margin-top:4px;border:0">`;
  return [
    `<div style="color:${MUTED}">${SIGNATURE_START}</div>`,
    `<div style="font-weight:bold;font-size:16px">${esc(sender.name.trim())}</div>`,
    role ? `<div>${role}</div>` : "",
    light ? img(dark ? "brand-logo-light" : "brand-logo", LOGO_CID, light, false) : "",
    light && dark ? img("brand-logo-dark", LOGO_DARK_CID, dark, true) : "",
  ].join("");
}

/** The email's HTML content (no document wrapper): the words, the signature and the footer, in the app's own colours. */
function bodyHtml(fullText: string, sender: SenderIdentity, config: Pick<Config, "logos" | "business">, mode: "cid" | "data"): string | null {
  const text = fullText.replace(/\r\n?/g, "\n");
  const at = text.lastIndexOf(`\n${SIGNATURE_START}\n`);
  if (at < 0) return null;
  const before = text.slice(0, at);
  const after = text.slice(at + SIGNATURE_START.length + 2).split(/\n{2,}/);
  const legal = after.slice(1).join("\n\n").trim(); // address + opt-out, under the signature block
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">` +
    paragraphs(before, linkPattern(hostOf(config.business.company.site))) +
    `<div style="margin:0 0 14px">${signatureHtml(sender, config, mode)}</div>` +
    (legal ? `<p style="margin:0;font-size:12px;color:${MUTED}">${esc(legal).replace(/\n/g, "<br>")}</p>` : "") +
    `</div>`
  );
}

/**
 * The HTML alternative of a composed email: the same words, with the signature shown like the team's
 * Gmail signature, light or dark to match the reader's mail app. Returns null for a body without our
 * signature block (older drafts): those go out as plain text only. The plain-text part always goes too.
 */
export function emailHtml(fullText: string, sender: SenderIdentity, config: Pick<Config, "logos" | "business">): { html: string; inline: InlineImage[] } | null {
  const body = bodyHtml(fullText, sender, config, "cid");
  if (!body) return null;
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<style>${DARK_MODE_CSS}</style></head><body>${body}</body></html>`;
  return {
    html,
    inline: [
      ...(config.logos.light ? [{ cid: LOGO_CID, filename: "logo.png", contentType: "image/png", base64: config.logos.light }] : []),
      ...(config.logos.light && config.logos.dark ? [{ cid: LOGO_DARK_CID, filename: "logo-dark.png", contentType: "image/png", base64: config.logos.dark }] : []),
    ],
  };
}

/** The text that actually goes out: the written part plus the mailbox's current signature and footer. */
export function outgoingBody(body: string, config: Config, sender: SenderIdentity): string {
  return hasFooter(body) ? composeBody(stripFooter(body), config, sender) : body;
}

/** The email as the lead will see it, for previews in the dashboard (logos as data URIs, colours from the dashboard's theme). */
export function previewHtml(body: string, config: Config, sender: SenderIdentity): string | null {
  return bodyHtml(outgoingBody(body, config, sender), sender, config, "data");
}

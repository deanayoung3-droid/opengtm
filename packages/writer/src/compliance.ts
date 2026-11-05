import { sendingBlockers, type Config } from "@opengtm/core";
import type { Issue } from "./rules";

export interface SenderIdentity {
  name: string;
  title?: string | null;
  /** Shown as "Title | C: phone" in the signature. */
  phone?: string | null;
}

export const OPT_OUT_LINE = `Reply "stop" and I won't email again.`;
/** The opt-out wording before 2026-10-26; drafts written with it still count as having a footer. */
const LEGACY_OPT_OUT = `If you'd rather not hear from me, just reply "stop" and I won't email again.`;

export const SIGN_OFF = "Best,";
/** The standard signature delimiter line; the HTML version starts its signature block here. */
export const SIGNATURE_START = "--";

/** The signature's "Title | C: phone" line (empty when the mailbox has neither). */
export function signatureRole(sender: SenderIdentity): string {
  return [sender.title?.trim(), sender.phone?.trim() ? `C: ${sender.phone.trim()}` : ""].filter(Boolean).join(" | ");
}

/**
 * A short sign-off ("Best,\nEmma"), then the team's email signature ("--", full name, "Title | C:
 * phone", the company name; the HTML version shows the logo if set), then the one line CAN-SPAM requires (who we
 * are, our postal address, how to opt out), kept short so the email still reads like a personal note.
 */
export function buildFooter(config: Config, sender: SenderIdentity): string {
  const company = config.business.company;
  const where = company.physical_address.trim() ? `${company.name}, ${company.physical_address.trim()}` : company.name;
  const first = sender.name.trim().split(/\s+/)[0] ?? sender.name;
  const role = signatureRole(sender);
  return [SIGN_OFF, first, "", SIGNATURE_START, sender.name.trim(), ...(role ? [role] : []), company.name, "", `${where}. ${OPT_OUT_LINE}`].join("\n");
}

export function composeBody(body: string, config: Config, sender: SenderIdentity): string {
  return `${body.trim()}\n\n${buildFooter(config, sender)}`;
}

/** Whether a text already carries our footer (a reply typed in the inbox doesn't). */
export const hasFooter = (full: string) => full.includes(OPT_OUT_LINE) || full.includes(LEGACY_OPT_OUT);

/** The written part of a composed email, without our sign-off and footer (also the older "--" signature). */
export function stripFooter(full: string): string {
  if (!hasFooter(full)) return full.trim();
  // "Best," comes before the "--" signature; drafts from before 2026-10-26 had only one or the other.
  const signOff = full.lastIndexOf(`\n${SIGN_OFF}\n`);
  const i = signOff >= 0 ? signOff : full.lastIndexOf("\n--\n");
  return (i < 0 ? full : full.slice(0, i)).trim();
}

/**
 * Compliance check on the final, footer-included email. These are legal
 * requirements, so any issue blocks sending regardless of approval mode.
 */
export function checkCompliance(fullBody: string, config: Config, sender: SenderIdentity): Issue[] {
  const issues: Issue[] = [];
  for (const b of sendingBlockers(config)) issues.push({ code: "config_missing", message: `${b.field}: ${b.note}` });
  const address = config.business.company.physical_address.trim();
  if (address && !fullBody.includes(address)) issues.push({ code: "missing_address", message: "Physical address missing from footer" });
  if (!hasFooter(fullBody)) issues.push({ code: "missing_opt_out", message: "Opt-out line missing" });
  if (!fullBody.includes(config.business.company.name)) issues.push({ code: "missing_company", message: `Email must say it is from ${config.business.company.name}` });
  if (!sender.name.trim()) issues.push({ code: "missing_sender", message: "Sender name missing" });
  else if (!fullBody.includes(sender.name)) issues.push({ code: "missing_sender", message: "Sender name missing from signature" });
  return issues;
}

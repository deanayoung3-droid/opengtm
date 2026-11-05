import { teamDay, audit, csvRows, type Ctx, DAY, decryptLogin, domainOf, domains, threads, isValidEmailSyntax, mailboxes, type MailboxLogin, messages, encryptLogin, normalizeEmail } from "@opengtm/core";
import { and, asc, eq, isNotNull, like, ne, or } from "drizzle-orm";
import { checkLogin, type LoginResult } from "./check";

export interface InboxRow {
  email: string;
  login: MailboxLogin;
  senderName: string;
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
// Header names vendors use, most specific first (an app password beats the account password).
const COLUMNS = {
  email: ["email", "emailaddress", "inbox", "mailbox", "address", "username", "user", "login", "account", "smtpusername", "smtpuser"],
  pass: ["apppassword", "smtppassword", "password", "pass", "pw"],
  name: ["sendername", "displayname", "fullname", "name", "persona"],
  first: ["firstname", "first", "givenname"],
  last: ["lastname", "last", "surname", "familyname"],
  smtpHost: ["smtphost", "smtpserver"],
  smtpPort: ["smtpport"],
  imapHost: ["imaphost", "imapserver"],
  imapPort: ["imapport"],
} as const;

// Vendors fill empty name columns with placeholders (e.g. last name "Last").
const PLACEHOLDER_NAME = /^(last|last ?name|surname|first|first ?name|name|n\/?a|none|null|-|\.)$/i;

/** "daniela" / "DANIELA" -> "Daniela"; names already in mixed case are left as typed. */
function tidyName(name: string): string {
  if (name !== name.toLowerCase() && name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** "alex_sales" -> "Alex", "alex.lee" -> "Alex Lee" (when the CSV has no name column). */
function nameFromAddress(email: string): string {
  const words = email
    .split("@")[0]!
    .split(/[._-]+/)
    .filter((w) => /^[a-z]{2,}$/i.test(w) && !/^(team|mail|hello|info|sales|outreach|contact)$/i.test(w));
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ") || email.split("@")[0]!;
}

/**
 * Read a mailbox vendor's export: one inbox per row with its address and
 * app password; SMTP/IMAP servers and sender names are optional (Google's servers are the default).
 * Works with or without a header row. Never echoes passwords back in problems.
 */
export function parseInboxCsv(text: string): { inboxes: InboxRow[]; problems: string[] } {
  const rows = csvRows(text).map((r) => r.map((c) => c.trim()));
  const problems: string[] = [];
  const inboxes = new Map<string, InboxRow>();
  if (!rows.length) return { inboxes: [], problems: ["The file is empty."] };

  const hasHeader = !rows[0]!.some((c) => c.includes("@"));
  const header = hasHeader ? rows[0]!.map(key) : [];
  const col = (names: readonly string[]) => names.map((n) => header.indexOf(n)).filter((i) => i >= 0);
  const pick = (r: string[], names: readonly string[]) => col(names).map((i) => r[i] ?? "").find(Boolean) ?? "";

  (hasHeader ? rows.slice(1) : rows).forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    let email: string;
    let pass: string;
    if (hasHeader) {
      email = pick(r, COLUMNS.email);
      pass = pick(r, COLUMNS.pass);
    } else {
      // No header: the address is the cell with an @, the password the next filled cell.
      const at = r.findIndex((c) => c.includes("@"));
      email = r[at] ?? "";
      pass = r.slice(at + 1).find((c) => c && !c.includes("@")) ?? "";
    }
    email = normalizeEmail(email);
    if (!isValidEmailSyntax(email)) return problems.push(`Line ${line}: no email address`);
    if (!pass) return problems.push(`Line ${line} (${email}): no password`);
    const smtpHost = pick(r, COLUMNS.smtpHost) || "smtp.gmail.com";
    const real = (v: string) => (v && !PLACEHOLDER_NAME.test(v) ? v : "");
    const name = tidyName(real(pick(r, COLUMNS.name)) || [real(pick(r, COLUMNS.first)), real(pick(r, COLUMNS.last))].filter(Boolean).join(" ") || nameFromAddress(email));
    inboxes.set(email, {
      email,
      senderName: name.slice(0, 60),
      login: {
        user: email,
        // Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of it.
        pass: /^([a-z]{4} ){3}[a-z]{4}$/i.test(pass) ? pass.replace(/ /g, "") : pass,
        smtpHost,
        smtpPort: Number(pick(r, COLUMNS.smtpPort)) || 587,
        imapHost: pick(r, COLUMNS.imapHost) || (/office365|outlook/i.test(smtpHost) ? "outlook.office365.com" : "imap.gmail.com"),
        imapPort: Number(pick(r, COLUMNS.imapPort)) || 993,
      },
    });
  });
  return { inboxes: [...inboxes.values()], problems };
}

export interface ImportResult {
  email: string;
  result: "added" | "updated";
  ok: boolean;
  /** Why the login failed (no secrets). */
  reason?: string;
}

const LOGIN_FAILED = "Login failed when imported";

/**
 * Add or update mailboxes from a parsed vendor export. Each login is tested first (nothing is sent);
 * passwords are stored encrypted. New inboxes start on the ramp's first tier today; one whose login
 * fails is added paused with the reason, and importing it again with the right password resumes it.
 * Existing inboxes keep their ramp, history and status; their login is replaced only by one that works.
 */
export async function importInboxes(
  ctx: Ctx,
  inboxes: InboxRow[],
  opts: { actor: string; check?: (l: MailboxLogin) => Promise<LoginResult>; concurrency?: number },
): Promise<ImportResult[]> {
  const check = opts.check ?? checkLogin;
  encryptLogin({ user: "", pass: "", smtpHost: "", smtpPort: 0, imapHost: "", imapPort: 0 }, ctx.env); // fail fast without a key
  const results: ImportResult[] = [];
  const queue = [...inboxes];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) results.push(await importOne(ctx, row, check, opts.actor));
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, inboxes.length) }, worker));
  await giveUniqueNames(ctx);
  return results.sort((a, b) => a.email.localeCompare(b.email));
}

async function importOne(ctx: Ctx, row: InboxRow, check: (l: MailboxLogin) => Promise<LoginResult>, actor: string): Promise<ImportResult> {
  const r = await check(row.login);
  const ok = r.smtp === "ok" && r.imap === "ok";
  const reason = ok ? undefined : r.smtp !== "ok" ? `sending: ${r.smtp}` : `reading: ${r.imap}`;
  const provider = /office365|outlook/i.test(row.login.smtpHost) ? "microsoft" : "google";
  const credentialsEnc = encryptLogin(row.login, ctx.env);

  const domainName = domainOf(row.email);
  await ctx.db.insert(domains).values({ name: domainName }).onConflictDoNothing();
  const [d] = await ctx.db.select().from(domains).where(eq(domains.name, domainName));
  const [existing] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, row.email));

  if (existing) {
    // A file with a wrong or missing app password must not replace a login that works.
    if (!ok) {
      await audit(ctx.db, actor, "mailbox.import", "mailboxes", row.email, { result: "kept", ok });
      return { email: row.email, result: "updated", ok, reason: `${reason}; kept its current login` };
    }
    const fixed = ok && existing.status === "paused" && (existing.pausedReason ?? "").startsWith(LOGIN_FAILED);
    await ctx.db
      .update(mailboxes)
      .set({ credentialsEnc, transport: "smtp", ...(fixed ? { status: "active" as const, pausedReason: null } : {}) })
      .where(eq(mailboxes.id, existing.id));
    await audit(ctx.db, actor, "mailbox.import", "mailboxes", row.email, { result: "updated", ok });
    return { email: row.email, result: "updated", ok, reason };
  }
  await ctx.db.insert(mailboxes).values({
    email: row.email,
    provider,
    transport: "smtp",
    domainId: d!.id,
    senderName: row.senderName,
    status: ok ? "active" : "paused",
    pausedReason: ok ? null : `${LOGIN_FAILED}: ${reason}`,
    rampStartDate: ctx.clock.now(),
    credentialsEnc,
    createdAt: ctx.clock.now(), // the login give-up timer counts from here, on the engine's clock
  });
  await audit(ctx.db, actor, "mailbox.import", "mailboxes", row.email, { result: "added", ok });
  return { email: row.email, result: "added", ok, reason };
}

/**
 * Inboxes paused because Google turned down their login are tried again (hourly job): at import (Google often
 * turns down new accounts' app passwords for a while) or later while sending (2026-11-02: a whole domain's
 * logins failed for a few hours while the vendor saw nothing wrong). One that logs in is switched on; one
 * still failing after give_up_days alerts the team once a day, since the password itself is then wrong.
 */
export async function retryFailedLogins(
  ctx: Ctx,
  opts: { check?: (l: MailboxLogin) => Promise<LoginResult>; alertAfterDays?: number } = {},
): Promise<{ tried: number; resumed: string[] }> {
  const check = opts.check ?? checkLogin;
  const rows = await ctx.db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.status, "paused"),
        or(like(mailboxes.pausedReason, `${LOGIN_FAILED}%`), like(mailboxes.pausedReason, "authentication failed%"), like(mailboxes.pausedReason, "inbox auth failed%")),
        isNotNull(mailboxes.credentialsEnc),
      ),
    );
  const resumed: string[] = [];
  const now = ctx.clock.now();
  for (const mb of rows) {
    let r: LoginResult;
    try {
      r = await check(decryptLogin(mb.credentialsEnc!, ctx.env));
    } catch (err) {
      r = { smtp: (err as Error).message, imap: "not checked" };
    }
    if (r.smtp === "ok" && r.imap === "ok") {
      await ctx.db.update(mailboxes).set({ status: "active", pausedReason: null }).where(and(eq(mailboxes.id, mb.id), eq(mailboxes.status, "paused")));
      await audit(ctx.db, "system", "mailbox.login_ok", "mailboxes", mb.email);
      resumed.push(mb.email);
      continue;
    }
    const reason = r.smtp !== "ok" ? `sending: ${r.smtp}` : `reading: ${r.imap}`;
    await ctx.db.update(mailboxes).set({ pausedReason: `${LOGIN_FAILED}: ${reason} (trying again every hour)` }).where(eq(mailboxes.id, mb.id));
    const days = (now.getTime() - mb.createdAt.getTime()) / 86_400_000;
    if (days >= (opts.alertAfterDays ?? 3)) {
      await ctx.alerts.notify({
        level: "warn",
        key: `mailbox_login:${mb.id}:${teamDay(now)}`,
        quietMs: DAY,
        title: `Inbox still can't log in: ${mb.email}`,
        body: `Google has turned down its login for ${Math.floor(days)} days (${reason}). Ask the mailbox vendor for a working app password, then upload their CSV again on Channels.`,
      });
    }
  }
  return { tried: rows.length, resumed };
}

// Common US surnames for persona senders (never the team's own).
const SURNAMES = [
  "Collins", "Reyes", "Parker", "Bennett", "Hayes", "Foster", "Brooks", "Sullivan", "Morgan", "Price",
  "Hughes", "Ward", "Russell", "Griffin", "Coleman", "Perry", "Powell", "Jenkins", "Barnes", "Fisher",
  "Henderson", "Simmons", "Patterson", "Ross", "Wallace", "Cole", "West", "Jordan", "Graham", "Reed",
  "Kelly", "Howard", "Cooper", "Rivera", "Bailey", "Murphy", "Carter", "Turner", "Mitchell", "Campbell",
  "Evans", "Stewart", "Morris", "Rogers", "Nelson", "Hill", "Wright", "Lopez", "Scott", "Green",
  "Adams", "Baker", "Hall", "Allen", "King", "Lewis", "Walker", "Harris", "Clark", "Bryant",
];

/**
 * Vendors reuse the same few first names on every domain. Give each inbox that shares its sender name
 * with another one, and hasn't sent anything yet, its own last name ("Mary" -> "Mary Collins"), so every
 * inbox is a different person. Inboxes that already emailed someone keep their name (threads keep one sender).
 */
export async function giveUniqueNames(ctx: Ctx): Promise<{ email: string; name: string }[]> {
  const all = await ctx.db.select().from(mailboxes).where(ne(mailboxes.status, "retired")).orderBy(asc(mailboxes.email));
  const sentRows = await ctx.db
    .selectDistinct({ id: threads.mailboxId })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(eq(messages.status, "sent"));
  const sent = new Set(sentRows.map((r) => r.id));
  const key = (n: string) => n.trim().toLowerCase();
  const count = new Map<string, number>();
  for (const m of all) count.set(key(m.senderName), (count.get(key(m.senderName)) ?? 0) + 1);
  const usedLast = new Set(all.flatMap((m) => m.senderName.trim().split(/\s+/).slice(1).map((w) => w.toLowerCase())));

  const renamed: { email: string; name: string }[] = [];
  for (const m of all) {
    if (sent.has(m.id) || (count.get(key(m.senderName)) ?? 0) < 2) continue;
    const first = m.senderName.trim().split(/\s+/)[0]!;
    const last = SURNAMES.find((s) => !usedLast.has(s.toLowerCase()) && !count.has(key(`${first} ${s}`)));
    if (!last) break;
    const name = `${first} ${last}`;
    await ctx.db.update(mailboxes).set({ senderName: name }).where(eq(mailboxes.id, m.id));
    await audit(ctx.db, "system", "mailbox.unique_name", "mailboxes", m.email, { from: m.senderName, to: name });
    count.set(key(m.senderName), count.get(key(m.senderName))! - 1);
    count.set(key(name), 1);
    usedLast.add(last.toLowerCase());
    renamed.push({ email: m.email, name });
  }
  return renamed;
}

export interface RenameResult {
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
}

/** One rename per line: "old@domain, new@domain" (a comma, spaces or "->" between them). */
export function parseRenames(text: string): { pairs: { from: string; to: string }[]; problems: string[] } {
  const pairs: { from: string; to: string }[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const [from, to] = line.split(/\s*(?:,|->|→|\s)\s*/).filter(Boolean).map(normalizeEmail);
    if (!from || !to || !isValidEmailSyntax(from) || !isValidEmailSyntax(to)) return problems.push(`Line ${i + 1}: needs "old address, new address"`);
    if (domainOf(from) !== domainOf(to)) return problems.push(`Line ${i + 1}: ${from} and ${to} are on different domains`);
    pairs.push({ from, to });
  });
  return { pairs, problems };
}

// Pauses that a working login clears: a failed import, or sends/reads refused while the address changed.
const AUTH_PAUSE = new RegExp(`^(${LOGIN_FAILED}|authentication failed|inbox auth failed)`);

/**
 * The vendor changed an inbox's address (same Google account, so the same app password): move the
 * mailbox to the new address, keeping its ramp, threads, signature and login. Its sender name becomes the
 * new address's first name ("allison_sales@..." -> "Allison"). The login is tested under the new address;
 * if Google doesn't take it yet the inbox waits paused, and the hourly retry switches it on once it does.
 */
export async function renameInboxes(
  ctx: Ctx,
  pairs: { from: string; to: string }[],
  opts: { actor: string; check?: (l: MailboxLogin) => Promise<LoginResult> },
): Promise<RenameResult[]> {
  const check = opts.check ?? checkLogin;
  const out: RenameResult[] = [];
  for (const { from, to } of pairs) {
    const [mb] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, from));
    if (!mb) {
      out.push({ from, to, ok: false, reason: (await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, to))).length ? "already renamed" : "no inbox with that address" });
      continue;
    }
    if (!mb.credentialsEnc) {
      out.push({ from, to, ok: false, reason: "its login is set in .env, not imported; not renamed" });
      continue;
    }
    const login = { ...decryptLogin(mb.credentialsEnc, ctx.env), user: to };
    const r = await check(login);
    const ok = r.smtp === "ok" && r.imap === "ok";
    const reason = ok ? undefined : r.smtp !== "ok" ? `sending: ${r.smtp}` : `reading: ${r.imap}`;
    const authPaused = mb.status === "paused" && AUTH_PAUSE.test(mb.pausedReason ?? "");
    const status = ok ? (authPaused ? { status: "active" as const, pausedReason: null } : {})
      : mb.status === "active" || authPaused ? { status: "paused" as const, pausedReason: `${LOGIN_FAILED}: ${reason} (trying again every hour)` } : {};
    await ctx.db.update(mailboxes).set({ email: to, senderName: nameFromAddress(to), credentialsEnc: encryptLogin(login, ctx.env), ...status }).where(eq(mailboxes.id, mb.id));
    await audit(ctx.db, opts.actor, "mailbox.rename", "mailboxes", mb.id, { from, to, ok });
    out.push({ from, to, ok, reason });
  }
  return out;
}

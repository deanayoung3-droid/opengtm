/**
 * Operator CLI:  pnpm gtm <command> [args]
 *
 *   migrate                                   apply DB migrations
 *   config:check                              validate config and list HUMAN items
 *   kill on|off|status [--reason "..."]       global kill switch
 *   suppress <email|domain> [--reason "..."]  permanent suppression
 *   delete-contact <email>                    erase a person's data (keeps a suppression entry)
 *   import-leads <file.csv> --source <name> --terms-ok
 *   add-domain <domain>
 *   add-mailbox <email> --provider google|microsoft --transport gmail_api|graph|smtp --sender "Name" [--title "..."] --creds MB1 [--ramp-start YYYY-MM-DD]
 *   mailbox pause|resume|retire <email> [--reason "..."]
 *   run <job>                                 run one worker job now (see jobs.ts)
 *   digest                                    build and print the weekly digest
 *   dns-check <domain>                        verify SPF/DKIM/DMARC
 *   check-mailbox [MB1 MB2 ...]               log in to SMTP/IMAP mailboxes (all MBn_* if none given); sends nothing
 *   connect-google <email> --client-id .. --client-secret .. --creds MB1   (on a laptop) get a Gmail refresh token
 */
import {
  audit,
  companies,
  contacts,
  domains,
  humanTodos,
  isKillSwitchOn,
  mailboxes,
  normalizeEmail,
  pauseMailbox,
  resumeMailbox,
  retireMailbox,
  runMigrations,
  setKillSwitch,
  suppress,
} from "@opengtm/core";
import { checkDomainDns } from "@opengtm/infra";
import { buildWeeklyDigest } from "@opengtm/learning";
import { CsvLeadSource, runDiscover } from "@opengtm/leads";
import { eq, sql } from "drizzle-orm";
import { buildRuntime } from "./context";
import { connectGoogle } from "./google-connect";
import { checkMailboxLogin } from "@opengtm/sequencer";
import { buildJobs } from "./jobs";

const [, , cmd, ...rest] = process.argv;
const flags: Record<string, string | true> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) {
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else flags[a.slice(2)] = true;
  } else args.push(a);
}
const actor = `cli:${process.env.USER ?? "operator"}`;
const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  if (cmd === "migrate") {
    await runMigrations(process.env.DATABASE_URL ?? die("DATABASE_URL is not set"));
    console.log("migrations applied");
    return;
  }
  if (cmd === "check-mailbox") {
    const prefixes = args.length ? args : [...new Set(Object.keys(process.env).filter((k) => /^MB\d+_SMTP_USER$/.test(k)).map((k) => k.split("_")[0]!))].sort();
    if (!prefixes.length) die("no MBn_SMTP_USER settings found");
    let bad = 0;
    for (const p of prefixes) {
      const r = await checkMailboxLogin(p, process.env);
      const ok = r.smtp === "ok" && r.imap === "ok";
      if (!ok) bad++;
      console.log(`${ok ? "OK  " : "FAIL"} ${p} ${r.user ?? "(no address)"}  send: ${r.smtp}  read: ${r.imap}${r.inboxMessages !== undefined ? ` (${r.inboxMessages} in inbox)` : ""}`);
    }
    process.exit(bad ? 1 : 0);
  }
  if (cmd === "connect-google") {
    const email = args[0] ?? die("usage: connect-google <mailbox email> --client-id <id> --client-secret <secret> --creds MB1");
    const clientId = str("client-id") ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? die("--client-id (or GOOGLE_OAUTH_CLIENT_ID)");
    const clientSecret = str("client-secret") ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? die("--client-secret (or GOOGLE_OAUTH_CLIENT_SECRET)");
    const prefix = str("creds") ?? "MB1";
    const r = await connectGoogle({ clientId, clientSecret, email });
    if (r.email && normalizeEmail(r.email) !== normalizeEmail(email)) die(`signed in as ${r.email}, not ${email}; run it again and pick ${email}`);
    console.log(`\nConnected ${r.email ?? email}. Add these to .env (values are secrets):\n`);
    console.log(`${prefix}_GOOGLE_CLIENT_ID=${clientId}\n${prefix}_GOOGLE_CLIENT_SECRET=${clientSecret}\n${prefix}_GOOGLE_REFRESH_TOKEN=${r.refreshToken}`);
    console.log(`\nThen on the server: node dist/cli.mjs add-mailbox ${email} --provider google --transport gmail_api --sender "Real Name" --creds ${prefix}`);
    return;
  }
  if (cmd === "dns-check") {
    const domain = args[0] ?? die("usage: dns-check <domain>");
    console.log(JSON.stringify(await checkDomainDns(domain, { dkimSelectors: (str("selectors") ?? "google,selector1,selector2").split(",") }), null, 2));
    return;
  }

  const rt = buildRuntime(process.env, "cli");
  const { ctx } = rt;
  try {
    switch (cmd) {
      case "config:check": {
        const todos = humanTodos(ctx.config);
        console.log(todos.length ? todos.map((t) => `${t.blocksSending ? "BLOCKS SENDING" : "todo          "}  ${t.field}: ${t.note}`).join("\n") : "config complete");
        break;
      }
      case "kill": {
        const sub = args[0];
        if (sub === "status") console.log(`kill switch is ${(await isKillSwitchOn(ctx.db)) ? "ON (nothing sends)" : "off"}`);
        else if (sub === "on" || sub === "off") {
          await setKillSwitch(ctx.db, sub === "on", actor, str("reason") ?? "");
          console.log(`kill switch ${sub.toUpperCase()}`);
        } else die("usage: kill on|off|status");
        break;
      }
      case "suppress": {
        const target = args[0] ?? die("usage: suppress <email|domain>");
        await suppress(ctx.db, /^[^@]+@/.test(target) ? { email: target } : { domain: target }, str("reason") ?? "manual", actor);
        await audit(ctx.db, actor, "suppress", "suppression", target);
        console.log(`suppressed ${target}`);
        break;
      }
      case "delete-contact": {
        const email = normalizeEmail(args[0] ?? die("usage: delete-contact <email>"));
        // Keep a suppression row so we never re-acquire and email them; drop everything else.
        await suppress(ctx.db, { email }, "deletion request", actor);
        const deleted = await ctx.db.delete(contacts).where(eq(sql`lower(${contacts.email})`, email)).returning({ id: contacts.id, companyId: contacts.companyId });
        for (const d of deleted) {
          const [left] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.companyId, d.companyId));
          if ((left?.n ?? 0) === 0) await ctx.db.delete(companies).where(eq(companies.id, d.companyId));
        }
        await audit(ctx.db, actor, "contact.delete", "contacts", email, { rows: deleted.length });
        console.log(`deleted ${deleted.length} contact row(s) for ${email}; suppression kept`);
        break;
      }
      case "import-leads": {
        const file = args[0] ?? die("usage: import-leads <file.csv> --source <name> --terms-ok");
        if (!flags["terms-ok"]) die("Refusing to import: pass --terms-ok only after confirming the source's terms allow internal outbound use.");
        const src = CsvLeadSource.fromFile(file, { name: str("source") ?? "csv_import", termsAllowOutbound: true });
        console.log(JSON.stringify(await runDiscover(ctx, [src], { limitPerSegment: 100_000, segmentId: str("segment") }), null, 2));
        break;
      }
      case "add-domain": {
        const name = args[0] ?? die("usage: add-domain <domain>");
        await ctx.db.insert(domains).values({ name }).onConflictDoNothing();
        console.log(`domain ${name} added`);
        break;
      }
      case "add-mailbox": {
        const email = normalizeEmail(args[0] ?? die("usage: add-mailbox <email> ..."));
        const provider = (str("provider") ?? die("--provider google|microsoft")) as "google" | "microsoft";
        const transport = (str("transport") ?? (provider === "google" ? "gmail_api" : "graph")) as "gmail_api" | "graph" | "smtp";
        const domainName = email.split("@")[1]!;
        await ctx.db.insert(domains).values({ name: domainName }).onConflictDoNothing();
        const [d] = await ctx.db.select().from(domains).where(eq(domains.name, domainName));
        await ctx.db.insert(mailboxes).values({
          email,
          provider,
          transport,
          domainId: d!.id,
          senderName: str("sender") ?? die("--sender \"Real Name\" (a team member who consented)"),
          senderTitle: str("title") ?? null,
          senderPhone: str("phone") ?? null,
          credentialsEnv: str("creds") ?? die("--creds <ENV_PREFIX>"),
          rampStartDate: str("ramp-start") ? new Date(str("ramp-start")!) : new Date(),
        });
        await audit(ctx.db, actor, "mailbox.add", "mailboxes", email);
        console.log(`mailbox ${email} added (${provider}/${transport})`);
        break;
      }
      case "mailbox": {
        const [sub, email] = args;
        const [mb] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, normalizeEmail(email ?? "")));
        if (!mb) die("mailbox not found");
        if (sub === "pause") await pauseMailbox(ctx, mb.id, str("reason") ?? `paused by ${actor}`);
        else if (sub === "resume") await resumeMailbox(ctx, mb.id, actor);
        else if (sub === "retire") await retireMailbox(ctx, mb.id, str("reason") ?? `retired by ${actor}`);
        else die("usage: mailbox pause|resume|retire <email>");
        console.log(`mailbox ${mb.email}: ${sub}`);
        break;
      }
      case "run": {
        const jobs = buildJobs(rt);
        const job = jobs[args[0] ?? ""] ?? die(`usage: run <${Object.keys(jobs).join("|")}>`);
        console.log(JSON.stringify(await job.run(), null, 2));
        break;
      }
      case "digest":
        console.log((await buildWeeklyDigest(ctx)).markdown);
        break;
      default:
        die("unknown command; see the header of apps/worker/src/cli.ts");
    }
  } finally {
    await rt.close();
  }
}

await main();

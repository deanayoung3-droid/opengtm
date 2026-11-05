import { randomBytes } from "node:crypto";
import {
  DAY,
  domains,
  HOUR,
  mailboxes,
  messages,
  MINUTE,
  recordEvent,
  retireMailbox,
  seedTests,
  type Ctx,
} from "@opengtm/core";
import { newMessageId, type MailTransport } from "@opengtm/sequencer";
import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { seedPlacementByMailbox } from "./health";

type Mailbox = typeof mailboxes.$inferSelect;
export type Placement = "inbox" | "spam" | "missing";

export interface SeedChecker {
  /** Where did the message carrying `token` land in this seed inbox? null = not arrived yet. */
  locate(seedInbox: string, token: string): Promise<Placement | null>;
}

const SPAM_FOLDERS = ["[Gmail]/Spam", "Junk", "Junk Email", "Spam", "Bulk Mail"];

/** Reads owned seed inboxes over IMAP (Gmail with app password, Outlook.com). */
export class ImapSeedChecker implements SeedChecker {
  constructor(private credsFor: (seedInbox: string) => { host: string; port: number; user: string; pass: string } | null) {}

  async locate(seedInbox: string, token: string): Promise<Placement | null> {
    const creds = this.credsFor(seedInbox);
    if (!creds) throw new Error(`no IMAP credentials for seed inbox ${seedInbox}`);
    const client = new ImapFlow({ host: creds.host, port: creds.port, secure: creds.port === 993, auth: { user: creds.user, pass: creds.pass }, logger: false });
    client.on("error", () => undefined); // a socket timeout fails this check instead of crashing the process
    await client.connect();
    try {
      const search = async (folder: string) => {
        try {
          const lock = await client.getMailboxLock(folder);
          try {
            const hits = await client.search({ body: token });
            return Array.isArray(hits) && hits.length > 0;
          } finally {
            lock.release();
          }
        } catch {
          return false; // folder does not exist on this provider
        }
      };
      if (await search("INBOX")) return "inbox";
      for (const f of SPAM_FOLDERS) if (await search(f)) return "spam";
      return null;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

export class FakeSeedChecker implements SeedChecker {
  constructor(public result: (inbox: string, token: string) => Placement | null) {}
  async locate(inbox: string, token: string) {
    return this.result(inbox, token);
  }
}

/** A seed test is due weekly per mailbox, or sooner after a health dip. */
export async function mailboxesDueForSeed(ctx: Ctx): Promise<Mailbox[]> {
  const now = ctx.clock.now();
  const mbs = await ctx.db.select().from(mailboxes).where(inArray(mailboxes.status, ["active", "warming"]));
  const out: Mailbox[] = [];
  for (const mb of mbs) {
    const [last] = await ctx.db.select().from(seedTests).where(eq(seedTests.mailboxId, mb.id)).orderBy(desc(seedTests.sentAt)).limit(1);
    const age = last ? now.getTime() - last.sentAt.getTime() : Infinity;
    if (age >= 7 * DAY || (mb.healthScore < 80 && age >= DAY)) out.push(mb);
  }
  return out;
}

/** Send one realistic message from each due mailbox to every seed inbox. */
export async function runSeedSend(ctx: Ctx, transportFor: (mb: Mailbox) => MailTransport): Promise<number> {
  const seeds = ctx.config.engine.health.seed_inboxes;
  if (seeds.length === 0) return 0;
  let sent = 0;
  for (const mb of await mailboxesDueForSeed(ctx)) {
    // Use real copy this mailbox sent recently, so placement reflects actual content.
    const [sample] = await ctx.db
      .select({ subject: messages.subject, body: messages.body })
      .from(messages)
      .where(and(eq(messages.mailboxId, mb.id), eq(messages.status, "sent"), eq(messages.stepNumber, 1)))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    for (const seed of seeds) {
      const token = `ref-${randomBytes(6).toString("hex")}`;
      const body = `${sample?.body ?? `Hi there,\n\nQuick note from ${mb.senderName} at ${ctx.config.business.company.name}.`}\n\n${token}`;
      try {
        await transportFor(mb).send({
          from: { name: mb.senderName, address: mb.email },
          replyTo: mb.email,
          to: seed.address,
          subject: sample?.subject ?? "quick note",
          text: body,
          messageId: newMessageId(mb.email),
          listUnsubscribe: { mailto: `mailto:${mb.email}?subject=unsubscribe` },
        });
        await ctx.db.insert(seedTests).values({ mailboxId: mb.id, seedInbox: seed.address, seedProvider: seed.provider, token, sentAt: ctx.clock.now() });
        sent++;
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message, mailbox: mb.email }, "seed send failed");
      }
    }
  }
  return sent;
}

/**
 * Check pending seeds, then retire any mailbox (and any domain whose mailboxes
 * all) fall below the placement floor.
 */
export async function runSeedCheck(ctx: Ctx, checker: SeedChecker): Promise<{ checked: number; retired: string[] }> {
  const now = ctx.clock.now();
  const pending = await ctx.db
    .select()
    .from(seedTests)
    .where(and(eq(seedTests.placement, "pending"), lt(seedTests.sentAt, new Date(now.getTime() - 10 * MINUTE))));
  let checked = 0;
  for (const s of pending) {
    let placement: Placement | null;
    try {
      placement = await checker.locate(s.seedInbox, s.token);
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, seed: s.seedInbox }, "seed check failed");
      continue;
    }
    if (placement === null && now.getTime() - s.sentAt.getTime() > 2 * HOUR) placement = "missing";
    if (placement === null) continue;
    await ctx.db.update(seedTests).set({ placement, checkedAt: now }).where(eq(seedTests.id, s.id));
    await recordEvent(ctx.db, "seed_result", { mailboxId: s.mailboxId, data: { seed: s.seedInbox, placement }, at: now });
    checked++;
  }

  const floor = ctx.config.engine.health.min_seed_placement;
  const byMb = await seedPlacementByMailbox(ctx, new Date(now.getTime() - 14 * DAY));
  const retired: string[] = [];
  const mbs = await ctx.db.select().from(mailboxes).where(ne(mailboxes.status, "retired"));
  for (const mb of mbs) {
    const p = byMb.get(mb.id);
    if (!p || p.total < 2) continue;
    const rate = p.inbox / p.total;
    if (rate < floor) {
      await retireMailbox(ctx, mb.id, `seed placement ${(rate * 100).toFixed(0)}% < ${(floor * 100).toFixed(0)}% (${p.inbox}/${p.total} inboxed)`);
      retired.push(mb.email);
    }
  }
  // A domain is retired when every mailbox on it with enough data is below the floor.
  const allDomains = await ctx.db.select().from(domains).where(ne(domains.status, "retired"));
  for (const d of allDomains) {
    const onDomain = mbs.filter((m) => m.domainId === d.id).map((m) => byMb.get(m.id)).filter((p): p is { inbox: number; total: number } => !!p && p.total >= 2);
    if (onDomain.length && onDomain.every((p) => p.inbox / p.total < floor)) {
      await ctx.db.update(domains).set({ status: "retired", pausedReason: "seed placement below floor" }).where(eq(domains.id, d.id));
      await ctx.alerts.notify({ level: "warn", key: `domain_retired:${d.id}`, title: `Sending domain retired: ${d.name}`, body: "All mailboxes on this domain placed below the seed floor. Replace the domain." });
    }
  }
  return { checked, retired };
}

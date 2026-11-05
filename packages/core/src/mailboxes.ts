import { and, eq, ne } from "drizzle-orm";
import type { Ctx } from "./ctx";
import { domains, mailboxes } from "./db/schema";
import { recordEvent } from "./events";

/** Circuit breaker: take a mailbox out of rotation and alert. Idempotent. */
export async function pauseMailbox(ctx: Ctx, mailboxId: string, reason: string): Promise<boolean> {
  const [mb] = await ctx.db
    .update(mailboxes)
    .set({ status: "paused", pausedReason: reason })
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.status, "active")))
    .returning();
  if (!mb) return false;
  await recordEvent(ctx.db, "paused", { mailboxId, data: { reason }, at: ctx.clock.now() });
  await ctx.alerts.notify({ level: "critical", key: `mailbox_paused:${mailboxId}`, title: `Mailbox paused: ${mb.email}`, body: reason });
  return true;
}

export async function resumeMailbox(ctx: Ctx, mailboxId: string, actor: string): Promise<void> {
  await ctx.db.update(mailboxes).set({ status: "active", pausedReason: null }).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.status, "paused")));
  await recordEvent(ctx.db, "resumed", { mailboxId, data: { actor }, at: ctx.clock.now() });
}

export async function retireMailbox(ctx: Ctx, mailboxId: string, reason: string): Promise<void> {
  const [mb] = await ctx.db
    .update(mailboxes)
    .set({ status: "retired", pausedReason: reason })
    .where(and(eq(mailboxes.id, mailboxId), ne(mailboxes.status, "retired")))
    .returning();
  if (!mb) return;
  await recordEvent(ctx.db, "retired", { mailboxId, data: { reason }, at: ctx.clock.now() });
  await ctx.alerts.notify({ level: "warn", key: `mailbox_retired:${mailboxId}`, title: `Mailbox retired: ${mb.email}`, body: `${reason}. Replace it in Mailboxes & domains.` });
}

export async function pauseDomain(ctx: Ctx, domainId: string, reason: string): Promise<void> {
  const [d] = await ctx.db
    .update(domains)
    .set({ status: "paused", pausedReason: reason })
    .where(and(eq(domains.id, domainId), eq(domains.status, "active")))
    .returning();
  if (!d) return;
  await recordEvent(ctx.db, "paused", { data: { domain: d.name, reason }, at: ctx.clock.now() });
  await ctx.alerts.notify({ level: "critical", key: `domain_paused:${domainId}`, title: `Sending domain paused: ${d.name}`, body: reason });
}

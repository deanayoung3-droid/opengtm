import { audit, getAutoReply, isKillSwitchOn, mailboxes, replies, type Ctx } from "@opengtm/core";
import type { MailTransport } from "@opengtm/sequencer";
import { and, eq, gt, isNotNull, lte } from "drizzle-orm";
import { approveAndSendReply } from "./send";

type SendDeps = { transportFor: (mb: typeof mailboxes.$inferSelect) => MailTransport; publicBaseUrl?: string; unsubscribeSecret?: string };

/**
 * "Reply automatically after review": drafts whose review window has passed are sent as is.
 * Anything doubtful goes back to a person instead (they wrote again meanwhile, or the send failed).
 */
export async function runAutoReplies(ctx: Ctx, deps: SendDeps, limit = 20): Promise<{ sent: number; heldForPerson: number }> {
  const auto = await getAutoReply(ctx.db, ctx.config.engine.replies.auto_reply);
  if (!auto.enabled || (await isKillSwitchOn(ctx.db))) return { sent: 0, heldForPerson: 0 };
  const now = ctx.clock.now();
  const due = await ctx.db
    .select()
    .from(replies)
    .where(and(eq(replies.draftState, "pending"), isNotNull(replies.autoSendAt), lte(replies.autoSendAt, now)))
    .limit(limit);
  let sent = 0;
  let held = 0;
  const hold = async (id: string, reason: string) => {
    held++;
    await ctx.db.update(replies).set({ autoSendAt: null }).where(eq(replies.id, id));
    await audit(ctx.db, "auto-reply", "reply.auto_held", "replies", id, { reason });
  };
  for (const r of due) {
    if (r.threadId) {
      const [newer] = await ctx.db
        .select({ id: replies.id })
        .from(replies)
        .where(and(eq(replies.threadId, r.threadId), gt(replies.receivedAt, r.receivedAt)))
        .limit(1);
      if (newer) {
        await hold(r.id, "they wrote again before it went out");
        continue;
      }
    }
    try {
      await approveAndSendReply(ctx, r.id, "auto-reply", deps);
      sent++;
    } catch (err) {
      await hold(r.id, (err as Error).message);
      await ctx.alerts.notify({ level: "warn", key: `auto_reply_held:${r.id}`, title: "An auto-reply needs a person", body: `It could not go out by itself: ${(err as Error).message}` });
    }
  }
  return { sent, heldForPerson: held };
}

/** A person took over this conversation: stop the timer (the draft stays for them). */
export async function holdAutoReply(ctx: Ctx, replyId: string, actor: string): Promise<void> {
  await ctx.db.update(replies).set({ autoSendAt: null }).where(eq(replies.id, replyId));
  await audit(ctx.db, actor, "reply.auto_held", "replies", replyId, { reason: "held by a person" });
}

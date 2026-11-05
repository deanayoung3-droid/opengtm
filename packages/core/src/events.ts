import type { Db } from "./db/client";
import { auditLog, events, type EventType } from "./db/schema";

export interface EventFields {
  contactId?: string | null;
  messageId?: string | null;
  mailboxId?: string | null;
  threadId?: string | null;
  segmentId?: string | null;
  data?: Record<string, unknown>;
  at?: Date;
}

/** Append-only event log. Never update or delete rows in `events`. */
export async function recordEvent(db: Db, type: EventType, f: EventFields = {}): Promise<void> {
  await db.insert(events).values({
    type,
    contactId: f.contactId ?? null,
    messageId: f.messageId ?? null,
    mailboxId: f.mailboxId ?? null,
    threadId: f.threadId ?? null,
    segmentId: f.segmentId ?? null,
    data: f.data ?? {},
    ...(f.at ? { createdAt: f.at } : {}),
  });
}

export async function audit(
  db: Db,
  actor: string,
  action: string,
  entity?: string,
  entityId?: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({ actor, action, entity: entity ?? null, entityId: entityId ?? null, data });
}

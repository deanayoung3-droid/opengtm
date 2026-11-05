import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { contacts } from "./db/schema";
import { recordEvent } from "./events";
import { suppress } from "./suppression";

function sign(contactId: string, secret: string): string {
  return createHmac("sha256", secret).update(contactId).digest("base64url").slice(0, 22);
}

/** Opaque, unguessable per-contact token for one-click unsubscribe links. */
export function unsubscribeToken(contactId: string, secret: string): string {
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET is not set");
  return `${contactId}.${sign(contactId, secret)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  const [contactId, sig] = token.split(".");
  if (!contactId || !sig || !secret) return null;
  const expected = Buffer.from(sign(contactId, secret));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got) ? contactId : null;
}

/** Honor an unsubscribe immediately and permanently. Safe to call repeatedly. */
export async function handleUnsubscribe(db: Db, contactId: string, source: string): Promise<boolean> {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) return false;
  await suppress(db, { email: c.email }, "unsubscribe", source);
  await recordEvent(db, "unsub", { contactId, data: { source } });
  return true;
}

import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { settings } from "./db/schema";
import { audit, recordEvent } from "./events";

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row ? (row.value as T) : fallback;
}

/** Setting a value to null removes the override. */
export async function setSetting(db: Db, key: string, value: unknown, actor = "system"): Promise<void> {
  if (value === null || value === undefined) {
    await db.delete(settings).where(eq(settings.key, key));
    await audit(db, actor, "setting.clear", "settings", key);
    return;
  }
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  await audit(db, actor, "setting.update", "settings", key, { value });
}

const KILL = "kill_switch";

/** Global kill switch: when on, nothing is sent and no sequences advance. */
export async function isKillSwitchOn(db: Db): Promise<boolean> {
  const v = await getSetting<{ on: boolean }>(db, KILL, { on: false });
  return v.on;
}

export async function setKillSwitch(db: Db, on: boolean, actor: string, reason = ""): Promise<void> {
  await setSetting(db, KILL, { on, reason, at: new Date().toISOString() }, actor);
  await recordEvent(db, "kill_switch", { data: { on, actor, reason } });
}

/** Runtime override of engine.yaml approval.force_all (dashboard toggle). null = use config. */
export async function getForceApproval(db: Db): Promise<boolean | null> {
  return getSetting<boolean | null>(db, "force_approval", null);
}

export type AutoReply = { enabled: boolean; delayMinutes: number };
/** The choices for "Reply automatically after review". */
export const AUTO_REPLY_DELAYS = [0, 30, 60, 120, 240, 480, 1440] as const;

/** Auto-reply (dashboard Settings, else engine.yaml replies.auto_reply). */
export async function getAutoReply(db: Db, fallback: { enabled: boolean; delay_minutes: number } | undefined): Promise<AutoReply> {
  const base = { enabled: fallback?.enabled ?? true, delayMinutes: fallback?.delay_minutes ?? 240 };
  return { ...base, ...(await getSetting<Partial<AutoReply> | null>(db, "auto_reply", null)) };
}

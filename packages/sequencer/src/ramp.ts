import { DAY, type EngineConfig, type mailboxes } from "@opengtm/core";

type Mailbox = typeof mailboxes.$inferSelect;

/**
 * Per-mailbox daily cap from the ramp table (week 1, 2, 3+), clamped to the
 * hard max. A mailbox with poor health is held at the first tier.
 */
export function dailyCap(mb: Pick<Mailbox, "rampStartDate" | "dailyCapOverride" | "healthScore" | "status">, now: Date, cfg: EngineConfig["ramp"]): number {
  if (mb.status !== "active") return 0;
  if (mb.dailyCapOverride !== null && mb.dailyCapOverride !== undefined) return Math.min(mb.dailyCapOverride, cfg.hard_max_per_day);
  const week = Math.max(1, Math.floor((now.getTime() - new Date(mb.rampStartDate).getTime()) / (7 * DAY)) + 1);
  const tiers = [...cfg.tiers].sort((a, b) => a.from_week - b.from_week);
  let cap = tiers[0]!.per_day;
  if (mb.healthScore >= cfg.hold_below_health) {
    for (const t of tiers) if (week >= t.from_week) cap = t.per_day;
  }
  return Math.min(cap, cfg.hard_max_per_day);
}

export function jitterMs(random: () => number, minS: number, maxS: number): number {
  return Math.round((minS + random() * (maxS - minS)) * 1000);
}

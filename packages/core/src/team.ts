import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Db } from "./db/client";
import { auditLog, teamMembers } from "./db/schema";
import { isValidEmailSyntax, normalizeEmail } from "./text";

/**
 * The workspace: everyone has their own sign-in (their email, verified by Cloudflare Access, or a
 * shared login on a single-user install) and the same rights; the only per-person data is their name. Teammates invite each other.
 */
export type Member = typeof teamMembers.$inferSelect;
export type NotifyKind = keyof Member["notify"];
export const NOTIFY_KINDS: { kind: NotifyKind; label: string; hint: string }[] = [
  { kind: "hot", label: "Hot leads", hint: "Someone said yes or asked a buying question" },
  { kind: "replies", label: "Every reply", hint: "Any human reply, including no thanks and hand-offs" },
  { kind: "problems", label: "Problems", hint: "Paused mailboxes, bounce spikes, spend cap, failed sends" },
];
export class TeamError extends Error {}


/** A name to start with: "dana.whitfield@x.com" -> "Dana Whitfield". */
export function nameFromEmail(email: string): string {
  return (email.split("@")[0] ?? "")
    .split(/[._-]+/)
    .filter((p) => p && !/^\d+$/.test(p))
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ");
}

export async function listMembers(db: Db): Promise<Member[]> {
  return db.select().from(teamMembers).where(eq(teamMembers.status, "active")).orderBy(asc(teamMembers.createdAt));
}

export async function inviteMember(db: Db, email: string, name: string, by: string): Promise<Member> {
  const e = normalizeEmail(email);
  if (!isValidEmailSyntax(e)) throw new TeamError(`"${email}" is not a valid email address`);
  const [m] = await db
    .insert(teamMembers)
    .values({ email: e, name: name.trim() || nameFromEmail(e), invitedBy: by })
    .onConflictDoUpdate({ target: teamMembers.email, set: { status: "active", invitedBy: by, ...(name.trim() ? { name: name.trim() } : {}) } })
    .returning();
  await db.insert(auditLog).values({ actor: by, action: "team.invite", entity: "team_members", entityId: m!.id, data: { email: e } });
  return m!;
}

export async function renameMember(db: Db, id: string, name: string, by: string): Promise<void> {
  const n = name.trim();
  if (!n) throw new TeamError("Name can't be empty");
  await db.update(teamMembers).set({ name: n.slice(0, 80) }).where(eq(teamMembers.id, id));
  await db.insert(auditLog).values({ actor: by, action: "team.rename", entity: "team_members", entityId: id, data: { name: n } });
}

/** Anyone may remove anyone from the list of people who get emails. */
export async function removeMember(db: Db, id: string, by: string): Promise<void> {
  await db.update(teamMembers).set({ status: "removed" }).where(eq(teamMembers.id, id));
  await db.insert(auditLog).values({ actor: by, action: "team.remove", entity: "team_members", entityId: id });
}

export async function setNotify(db: Db, id: string, notify: Member["notify"], by: string, alertEmail?: string): Promise<void> {
  const to = alertEmail === undefined ? undefined : normalizeEmail(alertEmail);
  if (to && !isValidEmailSyntax(to)) throw new TeamError(`"${alertEmail}" is not a valid email address`);
  await db
    .update(teamMembers)
    .set({ notify, ...(to === undefined ? {} : { alertEmail: to || null }) })
    .where(eq(teamMembers.id, id));
  await db.insert(auditLog).values({ actor: by, action: "team.notify", entity: "team_members", entityId: id, data: { ...notify, alertEmail: to ?? null } });
}

/** Active teammates who asked for this kind of email. */
export async function notifyRecipients(db: Db, kind: NotifyKind): Promise<string[]> {
  const rows = await db.select({ email: teamMembers.email, alertEmail: teamMembers.alertEmail, notify: teamMembers.notify }).from(teamMembers).where(eq(teamMembers.status, "active"));
  return [...new Set(rows.filter((r) => r.notify?.[kind]).map((r) => r.alertEmail || r.email))];
}

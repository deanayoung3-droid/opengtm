"use server";

import { audit, AUTO_REPLY_DELAYS, ConfigError, contacts, messages, threads, getAutoReply, inviteMember, mailboxes, removeMember, renameMember, setNotify, TeamError, domainOf, isFreeMailDomain, isValidEmailSyntax, normalizeDomain, normalizeEmail, pauseMailbox, replies, resumeMailbox, retireMailbox, saveProjectDocs, segments, setKillSwitch, setSetting, suppress, type ProjectDocs } from "@opengtm/core";
import { activateVariant, rejectVariant } from "@opengtm/learning";
import { approveAndSendReply, bookMeeting, holdAutoReply, draftReply, prepareBrief, rejectReplyDraft, setMeetingStage } from "@opengtm/replies";
import { syncSegments } from "@opengtm/leads";
import { giveUniqueNames, importInboxes, newMessageId, parseInboxCsv, parseRenames, renameInboxes } from "@opengtm/sequencer";
import { ApprovalError, approveMessage, bulkApprove, composeBody, emailHtml, redraftThread, rejectMessage } from "@opengtm/writer";
import { and, eq, inArray, ne } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actor, identity, rtReady } from "../lib/runtime";
import { APP_NAME } from "../lib/brand";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function back(path: string, error?: string, ok?: string): never {
  revalidatePath(path.split("?")[0]!);
  const sep = path.includes("?") ? "&" : "?";
  const q = error ? `${sep}error=${encodeURIComponent(error)}` : ok ? `${sep}ok=${encodeURIComponent(ok)}` : "";
  redirect(`${path}${q}`);
}

export async function approveMsg(fd: FormData) {
  const { ctx } = (await rtReady());
  const body = fd.has("body") ? s(fd, "body") : undefined;
  const subject = fd.has("subject") ? s(fd, "subject") : undefined;
  try {
    await approveMessage(ctx, s(fd, "id"), await actor(), body !== undefined || subject !== undefined ? { body, subject } : undefined);
  } catch (err) {
    const msg = err instanceof ApprovalError ? `${err.message}: ${err.issues.map((i) => i.message).join("; ")}` : (err as Error).message;
    back("/approvals", msg);
  }
  back("/approvals", undefined, "Approved");
}

export async function rejectMsg(fd: FormData) {
  await rejectMessage((await rtReady()).ctx, s(fd, "id"), await actor(), s(fd, "reason") || "rejected in review");
  back("/approvals", undefined, "Rejected; thread stopped");
}

/** Write a held sequence again, telling the writer what was wrong with it. */
export async function rewriteThreadAction(fd: FormData) {
  const { ctx } = await rtReady();
  const res = await redraftThread(ctx, s(fd, "thread"), await actor());
  if (!res) back("/approvals", "This one can't be rewritten: part of it already went out or is scheduled.");
  if (res.status === "skipped" || res.status === "stopped") back("/approvals", `Couldn't rewrite it: ${res.reason ?? res.status}.`);
  back(
    "/approvals",
    undefined,
    res.status === "needs_review" ? "Rewritten, but the new version was flagged too. It's below with the reasons." : "Rewritten and it passed every check. It sends on schedule.",
  );
}

export async function bulkApproveMsgs(fd: FormData) {
  const ids = fd.getAll("ids").map(String);
  if (!ids.length) back("/approvals", "Select at least one message");
  const r = await bulkApprove((await rtReady()).ctx, ids, await actor());
  back("/approvals", r.failed.length ? `${r.failed.length} could not be approved` : undefined, `Approved ${r.approved}`);
}

export async function sendReply(fd: FormData) {
  const r = await rtReady();
  try {
    const cc = fd.has("cc") ? list(s(fd, "cc")).map(normalizeEmail) : undefined;
    await approveAndSendReply(r.ctx, s(fd, "id"), await actor(), { transportFor: r.transportFor, publicBaseUrl: r.publicBaseUrl, unsubscribeSecret: r.unsubscribeSecret }, { ...(fd.has("body") ? { body: s(fd, "body") } : {}), ...(cc ? { cc } : {}) });
  } catch (err) {
    const msg = (err as Error).message;
    back(`/inbox?status=all&c=${s(fd, "id")}`, /physical_address/.test(msg) ? "Add your postal address on Project docs first. The law (CAN-SPAM) requires it in every email, replies included." : msg);
  }
  back(`/inbox?status=all&c=${s(fd, "id")}`, undefined, "Reply sent");
}

export async function rejectDraft(fd: FormData) {
  await rejectReplyDraft((await rtReady()).ctx, s(fd, "id"), await actor());
  back("/inbox", undefined, "Draft discarded");
}

export async function markHandled(fd: FormData) {
  const { ctx } = (await rtReady());
  await ctx.db.update(replies).set({ handled: true }).where(eq(replies.id, s(fd, "id")));
  await audit(ctx.db, await actor(), "reply.handled", "replies", s(fd, "id"));
  back("/inbox");
}

export async function book(fd: FormData) {
  const at = new Date(s(fd, "at"));
  if (Number.isNaN(at.getTime())) back("/inbox", "Pick a meeting date and time");
  await bookMeeting((await rtReady()).ctx, s(fd, "meetingId"), at, await actor(), (await rtReady()).crm);
  back("/inbox", undefined, "Meeting booked");
}

export async function meetingStage(fd: FormData) {
  await setMeetingStage((await rtReady()).ctx, s(fd, "meetingId"), s(fd, "stage") as "held" | "won" | "lost", await actor(), (await rtReady()).crm);
  back("/inbox");
}

export async function toggleKill(fd: FormData) {
  const on = s(fd, "on") === "true";
  await setKillSwitch((await rtReady()).ctx.db, on, await actor(), s(fd, "reason") || (on ? "dashboard" : "resumed from dashboard"));
  if (on) await (await rtReady()).ctx.alerts.notify({ level: "critical", key: `kill_switch:${Date.now()}`, title: "Kill switch turned ON", body: `by ${await actor()}` });
  back(s(fd, "from") || "/");
}

export async function setForceApproval(fd: FormData) {
  const v = s(fd, "value");
  await setSetting((await rtReady()).ctx.db, "force_approval", v === "config" ? null : v === "on", await actor());
  back("/settings", undefined, "Saved");
}

/** "Reply automatically after review": on/off and how long drafts wait for a person. */
export async function setAutoReplyAction(fd: FormData) {
  const { ctx } = await rtReady();
  const current = await getAutoReply(ctx.db, ctx.config.engine.replies.auto_reply);
  // The delay menu is disabled (so not submitted) while auto-reply is off: keep the saved delay then.
  const delay = fd.has("delay") ? Number(s(fd, "delay")) : current.delayMinutes;
  await setSetting(ctx.db, "auto_reply", { enabled: fd.get("enabled") === "on", delayMinutes: (AUTO_REPLY_DELAYS as readonly number[]).includes(delay) ? delay : current.delayMinutes }, await actor());
  back("/settings", undefined, "Saved");
}

/** Stop the auto-reply timer on one conversation; the draft waits for a person. */
export async function holdAutoReplyAction(fd: FormData) {
  const { ctx } = await rtReady();
  await holdAutoReply(ctx, s(fd, "id"), await actor());
  back(`/inbox?status=all&c=${s(fd, "id")}`, undefined, "Held. It won't send until someone sends it.");
}

export async function segmentStatus(fd: FormData) {
  const { ctx } = (await rtReady());
  const status = s(fd, "status") as "active" | "paused";
  await ctx.db.update(segments).set({ status, pausedReason: status === "paused" ? `paused by ${await actor()}` : null, updatedAt: new Date() }).where(eq(segments.id, s(fd, "id")));
  await audit(ctx.db, await actor(), `segment.${status}`, "segments", s(fd, "id"));
  back("/campaigns");
}

export async function variantAction(fd: FormData) {
  const fn = s(fd, "action") === "activate" ? activateVariant : rejectVariant;
  await fn((await rtReady()).ctx, s(fd, "sequenceId"), s(fd, "variant"), await actor());
  back("/campaigns");
}

export async function mailboxAction(fd: FormData) {
  const { ctx } = (await rtReady());
  const id = s(fd, "id");
  const who = await actor();
  const a = s(fd, "action");
  if (a === "pause") await pauseMailbox(ctx, id, s(fd, "reason") || `paused by ${who}`);
  else if (a === "resume") await resumeMailbox(ctx, id, who);
  else if (a === "retire") await retireMailbox(ctx, id, s(fd, "reason") || `retired by ${who}`);
  back("/mailboxes");
}

/** Add or update many inboxes at once from the vendor's CSV: each login is tested, passwords stored encrypted. */
export async function importInboxesAction(fd: FormData) {
  const { ctx } = await rtReady();
  const file = fd.get("file");
  const text = file instanceof File && file.size ? await file.text() : s(fd, "csv");
  if (!text) back("/mailboxes", "Choose the CSV file from your mailbox vendor, or paste its contents.");
  const { inboxes, problems } = parseInboxCsv(text);
  if (!inboxes.length) back("/mailboxes", `No inboxes found in that file. ${problems.slice(0, 3).join("; ")}`);
  let results: Awaited<ReturnType<typeof importInboxes>>;
  try {
    results = await importInboxes(ctx, inboxes, { actor: await actor() });
  } catch (err) {
    back("/mailboxes", (err as Error).message);
  }
  const added = results.filter((r) => r.result === "added").length;
  const failed = results.filter((r) => !r.ok);
  const msg = [
    `${added} inbox${added === 1 ? "" : "es"} added, ${results.length - added} updated.`,
    failed.length ? `${failed.length} couldn't log in (new ones are paused; ones already here keep their working login):${failed.slice(0, 4).map((f) => `${f.email} (${f.reason})`).join("; ")}${failed.length > 4 ? "; ..." : ""}.` : "Every login worked.",
    problems.length ? `Skipped ${problems.length} line${problems.length === 1 ? "" : "s"}: ${problems.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  back("/mailboxes", failed.length || problems.length ? msg : undefined, failed.length || problems.length ? undefined : msg);
}

/**
 * Run the lead search now instead of waiting for tomorrow's 6:00 AM run (say the morning run failed).
 * It buys only what the mailboxes are short of, the same as the scheduled run, so pressing it twice costs nothing extra.
 */
export async function runDiscoverNowAction() {
  await rtReady();
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false, supervise: false, migrate: false });
  await boss.start();
  try {
    await boss.send("discover", {});
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  await audit((await rtReady()).ctx.db, await actor(), "discover.run_now", "jobs", "discover");
  back("/schedule", undefined, "Lead search started. New companies show up on Leads over the next few minutes, then get researched, written and sent within business hours.");
}

/** Send the signed-in person one email from this mailbox, exactly as leads get them (signature and logo), to see it in a real inbox. */
export async function mailboxTestEmailAction(fd: FormData) {
  const r = await rtReady();
  const who = await identity();
  if (!isValidEmailSyntax(who)) back("/mailboxes", "Couldn't tell which email address you signed in with.");
  const [mb] = await r.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, s(fd, "id")));
  if (!mb) back("/mailboxes", "Mailbox not found.");
  const sender = { name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone };
  const text = composeBody(`Hi,\n\nThis is a test from ${APP_NAME} so you can see how emails from ${mb.email} arrive, signature and logo included. It went only to you.`, r.ctx.config, sender);
  const rich = emailHtml(text, sender, r.ctx.config);
  try {
    await r.transportFor(mb).send({
      from: { name: mb.senderName, address: mb.email },
      replyTo: mb.email,
      to: who,
      subject: `Signature test from ${mb.senderName}`,
      text,
      ...(rich ? { html: rich.html, inline: rich.inline } : {}),
      messageId: newMessageId(mb.email),
      listUnsubscribe: { mailto: `mailto:${mb.email}?subject=unsubscribe` },
    });
  } catch (err) {
    back("/mailboxes", `The test didn't send: ${(err as Error).message.slice(0, 200)}`);
  }
  await audit(r.ctx.db, `web:${who}`, "mailbox.test_email", "mailboxes", mb.id);
  back("/mailboxes", undefined, `Test sent to ${who} from ${mb.email}. It should arrive in a minute.`);
}

/** Inboxes whose address was changed at the vendor: same inbox, new address (keeps ramp, threads and login). */
export async function renameInboxesAction(fd: FormData) {
  const { ctx } = await rtReady();
  const { pairs, problems } = parseRenames(s(fd, "renames"));
  if (!pairs.length) back("/mailboxes", problems[0] ?? "Add one line per inbox: old address, new address.");
  const results = await renameInboxes(ctx, pairs, { actor: await actor() });
  const done = results.filter((r) => r.ok);
  const waiting = results.filter((r) => !r.ok);
  const msg = [
    `${done.length} renamed and logging in.`,
    waiting.length ? `${waiting.length} not working yet: ${waiting.slice(0, 4).map((r) => `${r.to} (${r.reason})`).join("; ")}${waiting.length > 4 ? "; ..." : ""}. Renamed ones that can't log in yet are tried again every hour.` : "",
    problems.length ? `Skipped: ${problems.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  back("/mailboxes", waiting.length || problems.length ? msg : undefined, waiting.length || problems.length ? undefined : msg);
}

/** Give every inbox that shares a name (and hasn't sent yet) its own last name, now instead of at the next hourly run. */
export async function uniqueNamesAction() {
  const { ctx } = await rtReady();
  const renamed = await giveUniqueNames(ctx);
  back("/mailboxes", undefined, renamed.length ? `${renamed.length} inboxes got their own full name, e.g. ${renamed.slice(0, 3).map((r) => r.name).join(", ")}.` : "Every inbox already has its own name.");
}

/** One title on every inbox's signature at once (phones stay as they are, set per inbox). */
export async function signatureTitleAllAction(fd: FormData) {
  const { ctx } = await rtReady();
  const title = s(fd, "title").slice(0, 60) || null;
  const rows = await ctx.db.update(mailboxes).set({ senderTitle: title }).where(ne(mailboxes.status, "retired")).returning({ id: mailboxes.id });
  await audit(ctx.db, await actor(), "mailbox.signature_all", "mailboxes", "*", { title, count: rows.length });
  back("/mailboxes", undefined, title ? `Every inbox's signature now says "${title}". The next emails use it.` : "Titles removed from every signature.");
}

/** A mailbox's signature line: title and phone (the name stays fixed so threads keep one sender). */
export async function mailboxSignatureAction(fd: FormData) {
  const { ctx } = await rtReady();
  const title = s(fd, "title").slice(0, 60) || null;
  const phone = s(fd, "phone").slice(0, 30) || null;
  if (phone && !/^[+\d][\d\s().-]{6,}$/.test(phone)) back("/mailboxes", "That phone number doesn't look right. Use digits, spaces, ( ) - and an optional + at the start.");
  await ctx.db.update(mailboxes).set({ senderTitle: title, senderPhone: phone }).where(eq(mailboxes.id, s(fd, "id")));
  await audit(ctx.db, await actor(), "mailbox.signature", "mailboxes", s(fd, "id"), { title, phone });
  back("/mailboxes", undefined, "Signature saved. The next email from this mailbox uses it.");
}

const lines = (v: string) => v.split(/\r?\n/).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
const list = (v: string) => v.split(/[\n,]/).map((l) => l.trim()).filter(Boolean);

async function saveDocs(patch: ProjectDocs, path: string, ok: string) {
  const r = await rtReady();
  try {
    r.ctx.config = await saveProjectDocs(r.ctx.db, r.baseConfig, patch, await actor());
  } catch (err) {
    if (err instanceof ConfigError) back(path, err.message);
    throw err;
  }
  back(path, undefined, ok);
}

/** Project docs: company profile, offer, pricing, proof, competitors, reply facts, reply Cc. */
export async function saveProjectDocsAction(fd: FormData) {
  await saveDocs(
    {
      company: {
        name: s(fd, "name"),
        site: s(fd, "site"),
        one_liner: s(fd, "one_liner"),
        thesis: s(fd, "thesis"),
        physical_address: s(fd, "physical_address"),
        pricing: s(fd, "pricing"),
        offer: s(fd, "offer"),
        booking_link: s(fd, "booking_link"),
        strengths: lines(s(fd, "strengths")),
        proof_points: lines(s(fd, "proof_points")).map((text, i) => ({ id: `pp${i + 1}`, text })),
        banned_claims: lines(s(fd, "banned_claims")),
      },
      competitors: list(s(fd, "competitors")),
      facts: s(fd, "facts"),
      outreach: { reply_cc: list(s(fd, "reply_cc")).map(normalizeEmail), demo_offer: s(fd, "demo_offer") || undefined },
    },
    "/project",
    "Saved. New emails and reply drafts use this right away.",
  );
}

export async function saveSequenceAction(fd: FormData) {
  await saveDocs({ outreach: { instructions: s(fd, "instructions"), cta_reply: s(fd, "cta_reply") || undefined } }, "/sequence", "Saved. New drafts follow these instructions.");
}

/** Add or edit a campaign (a segment: who it targets and which keywords find them). */
export async function saveCampaignAction(fd: FormData) {
  const r = await rtReady();
  const current = r.ctx.config.business.icp.segments;
  const name = s(fd, "name");
  const id = s(fd, "id") || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!id) back("/campaigns", "Give the campaign a name");
  const entry = { id, description: s(fd, "description") || name, keywords: list(s(fd, "keywords")).map((k) => k.toLowerCase()) };
  if (!entry.keywords.length) back("/campaigns", "Add at least one keyword so the lead search knows what to look for");
  const exists = current.some((c) => c.id === id);
  const next = exists ? current.map((c) => (c.id === id ? entry : c)) : [...current, entry];
  try {
    r.ctx.config = await saveProjectDocs(r.ctx.db, r.baseConfig, { icp: { segments: next } }, await actor());
  } catch (err) {
    if (err instanceof ConfigError) back("/campaigns", err.message);
    throw err;
  }
  await syncSegments(r.ctx);
  back("/campaigns", undefined, exists ? `Updated ${entry.description}` : `Created ${entry.description}. Leads start arriving with the next morning search.`);
}

/** Suppress list: emails or whole domains, one per line. Permanent, as the law and our rules require. */
export async function addSuppressionAction(fd: FormData) {
  const { ctx } = await rtReady();
  const reason = s(fd, "reason") || "added manually";
  const who = await actor();
  let n = 0;
  const bad: string[] = [];
  const personal: string[] = [];
  for (const raw of list(s(fd, "entries"))) {
    const v = raw.toLowerCase();
    if (v.includes("@")) {
      if (!isValidEmailSyntax(normalizeEmail(v))) {
        bad.push(raw);
        continue;
      }
      await suppress(ctx.db, { email: normalizeEmail(v) }, reason, `dashboard:${who}`);
    } else {
      const d = normalizeDomain(v.replace(/^@/, ""));
      if (!d || !d.includes(".")) {
        bad.push(raw);
        continue;
      }
      if (isFreeMailDomain(d)) {
        personal.push(d); // blocking gmail.com would block every company that uses Gmail
        continue;
      }
      await suppress(ctx.db, { domain: d }, reason, `dashboard:${who}`);
    }
    n++;
  }
  const skipped = [
    bad.length ? `Skipped ${bad.length} that weren't an email or domain: ${bad.slice(0, 3).join(", ")}.` : "",
    personal.length ? `Skipped ${personal.join(", ")}: that's a personal email provider, so add the person's full address instead.` : "",
  ].filter(Boolean);
  back("/suppress", skipped.length ? `Suppressed ${n}. ${skipped.join(" ")}` : undefined, `Suppressed ${n}. They will never be emailed.`);
}

/** Inbox: ask the model for a reply draft on demand. */
export async function draftWithAiAction(fd: FormData) {
  const { ctx } = await rtReady();
  const id = s(fd, "id");
  const r = await draftReply(ctx, id);
  back(`/inbox?c=${id}`, r.drafted ? undefined : `Could not draft automatically${r.issues.length ? `: ${r.issues[0]!.message}` : ""}. Write the reply yourself.`, r.drafted ? "Draft ready below. Edit it, then send." : undefined);
}

/** Inbox: set a conversation's status by hand. */
export async function setReplyStatusAction(fd: FormData) {
  const { ctx } = await rtReady();
  const id = s(fd, "id");
  const status = s(fd, "status");
  const set =
    status === "hot"
      ? { hot: true, handled: false }
      : status === "not_hot"
        ? { hot: false }
        : status === "handled"
          ? { handled: true }
          : status === "needs_reply"
            ? { handled: false }
            : status === "not_interested" || status === "stop"
              ? { label: status === "stop" ? undefined : ("objection" as const), hot: false, handled: true }
              : null;
  if (!set) back("/inbox", "Unknown status");
  // Any status change means a person has taken over: the auto-reply timer stops.
  await ctx.db.update(replies).set({ ...set, autoSendAt: null }).where(eq(replies.id, id));
  const who = await actor();
  await audit(ctx.db, who, `reply.status.${status}`, "replies", id);
  const [r] = status === "not_interested" || status === "stop" ? await ctx.db.select({ contactId: replies.contactId }).from(replies).where(eq(replies.id, id)) : [];
  const [c] = r?.contactId ? await ctx.db.select().from(contacts).where(eq(contacts.id, r.contactId)) : [];
  if (c && status === "stop") {
    // Never email this address again: suppressing it stops every sequence to them and cancels queued follow-ups.
    await suppress(ctx.db, { email: c.email }, `stopped by ${who}`, "dashboard");
    back(`/inbox?status=all&c=${id}`, undefined, `Stopped. ${c.email} won't get any more emails (it's on the Suppress list).`);
  }
  if (c && status === "not_interested") {
    // Same as a bare "no thanks": no more emails to them, including a follow-up already queued.
    await ctx.db.update(contacts).set({ status: "dropped", dropReason: "not interested", updatedAt: new Date() }).where(eq(contacts.id, c.id));
    await ctx.db.update(threads).set({ status: "stopped", stopReason: "not interested" }).where(and(eq(threads.contactId, c.id), inArray(threads.status, ["drafting", "active"])));
    await ctx.db.update(messages).set({ status: "cancelled" }).where(and(eq(messages.contactId, c.id), eq(messages.kind, "sequence"), inArray(messages.status, ["draft", "scheduled"])));
  }
  back(`/inbox?status=all&c=${id}`, undefined, "Status updated");
}

/** Team: invite a teammate (same rights as everyone). They sign in with this email. */
export async function inviteMemberAction(fd: FormData) {
  const { ctx } = await rtReady();
  try {
    const m = await inviteMember(ctx.db, s(fd, "email"), s(fd, "name"), await actor());
    back("/team", undefined, `Added ${m.email}. Choose what they get emailed about in Settings.`);
  } catch (err) {
    if (err instanceof TeamError) back("/team", err.message);
    throw err;
  }
}

export async function renameMemberAction(fd: FormData) {
  const { ctx } = await rtReady();
  try {
    await renameMember(ctx.db, s(fd, "id"), s(fd, "name"), await actor());
  } catch (err) {
    if (err instanceof TeamError) back("/team", err.message);
    throw err;
  }
  back("/team", undefined, "Name saved");
}

export async function removeMemberAction(fd: FormData) {
  const { ctx } = await rtReady();
  try {
    await removeMember(ctx.db, s(fd, "id"), await actor());
  } catch (err) {
    if (err instanceof TeamError) back("/team", err.message);
    throw err;
  }
  back("/team", undefined, "Removed from the workspace");
}

/** Settings > Email notifications: one teammate's toggles (unchecked boxes are simply absent). */
export async function setNotifyAction(fd: FormData) {
  const { ctx } = await rtReady();
  try {
    await setNotify(ctx.db, s(fd, "id"), { hot: fd.has("hot"), replies: fd.has("replies"), problems: fd.has("problems") }, await actor(), fd.has("alert_email") ? s(fd, "alert_email") : undefined);
  } catch (err) {
    if (err instanceof TeamError) back("/settings", err.message);
    throw err;
  }
  revalidatePath("/settings");
}

/** Write (or rewrite) a hot lead's demo prep from what we know about them and the conversation. */
export async function rebuildBriefAction(fd: FormData) {
  const { ctx } = await rtReady();
  const company = s(fd, "company");
  const brief = await prepareBrief(ctx, s(fd, "id"));
  await audit(ctx.db, await actor(), "meeting.brief", "meetings", s(fd, "id"));
  back(`/leads/${company}`, brief ? undefined : "Couldn't write the demo prep right now (the AI is unavailable or the daily spend cap is reached). Try again later.", brief ? "Demo prep is ready." : undefined);
}

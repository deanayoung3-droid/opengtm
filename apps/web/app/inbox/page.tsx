import { campaigns, companies, contacts, mailboxes, meetings, messages, newReplyText, replies, TEAM_TZ, threads } from "@opengtm/core";
import { signatureHtml, stripFooter } from "@opengtm/writer";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Segmented } from "../../components/Segmented";
import { AutoSubmitSelect } from "../../components/AutoSubmit";
import { Composer } from "../../components/Composer";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Badge, Empty, Flash, initials, pretty } from "../../components/ui";
import { engineDid, name, STATUS_NAME, when } from "../../lib/format";
import { rtReady } from "../../lib/runtime";
import { book, draftWithAiAction, holdAutoReplyAction, meetingStage, rejectDraft, sendReply, setReplyStatusAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inbox" };

const TABS: Record<string, { label: string; where?: SQL }> = {
  needs: { label: "Needs you", where: or(eq(replies.handled, false), eq(replies.draftState, "pending")) },
  hot: { label: "Hot", where: eq(replies.hot, true) },
  all: { label: "All replies" },
  sent: { label: "Sent" },
};

/** Our own emails: the body, and the signature/footer shown dimmed. */
const splitFooter = (body: string) => {
  const i = body.indexOf("\n--\n");
  return i < 0 ? [body, ""] : [body.slice(0, i), body.slice(i + 1)];
};
const day = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TEAM_TZ });
const HANDOFF = ["email_changed", "referral", "wrong_person"];

/** What a sent-only conversation is waiting on. */
function sentState(c: typeof contacts.$inferSelect, t: typeof threads.$inferSelect): { label: string; tone?: string } {
  if (c.status === "bounced") return { label: "Not delivered", tone: "bad" };
  if (c.status === "suppressed") return { label: "Unsubscribed" };
  if (c.status === "replied") return { label: "Replied", tone: "good" };
  if (c.status === "dropped") return { label: c.dropReason ? pretty(c.dropReason) : "Stopped" };
  if (t.pausedUntil && t.pausedUntil > new Date()) return { label: "Out of Office" };
  return t.status === "completed" ? { label: "Sequence finished" } : { label: "In sequence" };
}

/** "2h 10m" until a time (for the auto-reply countdown). */
function until(t: Date, now: Date): string {
  const m = Math.max(1, Math.round((t.getTime() - now.getTime()) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

export default async function Inbox({ searchParams }: { searchParams: Promise<{ status?: string; campaign?: string; q?: string; c?: string; t?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const now = new Date();
  const tab = TABS[sp.status ?? "needs"] ? (sp.status ?? "needs") : "needs";
  const { ctx } = await rtReady();
  const search = sp.q ? or(ilike(contacts.email, `%${sp.q}%`), ilike(contacts.firstName, `%${sp.q}%`), ilike(contacts.lastName, `%${sp.q}%`), ilike(companies.name, `%${sp.q}%`)) : undefined;
  const href = (p: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ status: tab, campaign: sp.campaign, q: sp.q, ...p }).filter(([, v]) => v) as [string, string][]);
    return `/inbox?${q}`;
  };

  // Left list: replies, or (Sent tab) everyone we've emailed.
  const filters: SQL[] = [];
  if (TABS[tab]!.where) filters.push(TABS[tab]!.where!);
  if (sp.campaign) filters.push(eq(campaigns.segmentId, sp.campaign));
  if (search) filters.push(search);
  const allReplies =
    tab === "sent"
      ? []
      : await ctx.db
          .select({ r: replies, c: contacts, co: companies, seg: campaigns.segmentId })
          .from(replies)
          .leftJoin(contacts, eq(contacts.id, replies.contactId))
          .leftJoin(companies, eq(companies.id, contacts.companyId))
          .leftJoin(threads, eq(threads.id, replies.threadId))
          .leftJoin(campaigns, eq(campaigns.id, threads.campaignId))
          .where(filters.length ? and(...filters) : undefined)
          .orderBy(desc(replies.receivedAt))
          .limit(500);
  // One row per conversation (decided 2026-11-04): its latest reply, marked hot if any reply in it was.
  const convoKey = (r: typeof replies.$inferSelect) => r.threadId ?? r.id;
  const byConvo = new Map<string, (typeof allReplies)[number] & { hot: boolean; n: number }>();
  for (const x of allReplies) {
    const row = byConvo.get(convoKey(x.r));
    if (!row) byConvo.set(convoKey(x.r), { ...x, hot: x.r.hot, n: 1 });
    else {
      row.hot ||= x.r.hot;
      row.n++;
    }
  }
  const replyList = [...byConvo.values()].slice(0, 150);
  const sentList =
    tab !== "sent"
      ? []
      : await ctx.db
          .select({ t: threads, c: contacts, co: companies, seg: campaigns.segmentId, last: sql<string>`max(${messages.sentAt})`, n: sql<number>`count(*)::int` })
          .from(messages)
          .innerJoin(threads, eq(threads.id, messages.threadId))
          .innerJoin(contacts, eq(contacts.id, threads.contactId))
          .innerJoin(companies, eq(companies.id, threads.companyId))
          .leftJoin(campaigns, eq(campaigns.id, threads.campaignId))
          .where(and(eq(messages.status, "sent"), sp.campaign ? eq(campaigns.segmentId, sp.campaign) : undefined, search))
          .groupBy(threads.id, contacts.id, companies.id, campaigns.segmentId)
          .orderBy(desc(sql`max(${messages.sentAt})`))
          .limit(150);

  // Right pane: the selected conversation.
  // A link to an older reply (e.g. from an alert email) opens its conversation at the latest reply.
  const wanted = allReplies.find((x) => x.r.id === sp.c);
  const pickedReply = (wanted && replyList.find((x) => convoKey(x.r) === convoKey(wanted.r))) ?? (tab !== "sent" ? replyList[0] : undefined);
  const pickedSent = sentList.find((x) => x.t.id === sp.t) ?? sentList[0];
  const sel = pickedReply?.r;
  const threadId = sel?.threadId ?? pickedSent?.t.id ?? null;
  const person = pickedReply?.c ?? pickedSent?.c ?? null;
  const company = pickedReply?.co ?? pickedSent?.co ?? null;
  const [thread, theirReplies, [mt], [mb]] = threadId
    ? await Promise.all([
        ctx.db.select().from(messages).where(and(eq(messages.threadId, threadId), eq(messages.status, "sent"))).orderBy(asc(messages.sentAt)),
        ctx.db.select().from(replies).where(eq(replies.threadId, threadId)).orderBy(asc(replies.receivedAt)),
        sel ? ctx.db.select().from(meetings).where(eq(meetings.replyId, sel.id)).limit(1) : Promise.resolve([]),
        ctx.db
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.id, sel?.mailboxId ?? pickedSent?.t.mailboxId ?? "00000000-0000-0000-0000-000000000000"))
          .limit(1),
      ])
    : [[], sel ? [sel] : [], [], []];
  const timeline = [
    ...thread.map((m) => ({ at: m.sentAt ?? m.createdAt, ours: true as const, m })),
    ...theirReplies.map((r) => ({ at: r.receivedAt, ours: false as const, r })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const did = sel ? engineDid(sel.actionTaken) : null;
  // Only the words to edit: the "Best, <name>" sign-off and the signature are added again when it's sent.
  const draftText = sel?.draftBody && sel.draftState === "pending" ? stripFooter(sel.draftBody) : "";
  const who = person ? name(person) : (sel?.fromEmail ?? "");
  const nextStep = (sel?.summary ?? "").replace(/ Asks: .*$/, "");
  const asks = (sel?.summary ?? "").match(/Asks: (.+)$/)?.[1];
  const count = tab === "sent" ? sentList.length : replyList.length;

  return (
    <>
      <div className="page-head">
        <div className="crumb">
          <Icon name={tab === "sent" ? "send" : "inbox"} />
          <span>{tab === "sent" ? "Sent" : "Inbox"}</span>
        </div>
        <div className="actions">
          <Segmented as="nav" className="seg-toggle" aria-label="Inbox views">
            {Object.entries(TABS).map(([k, v]) => (
              <Link key={k} href={href({ status: k, c: undefined, t: undefined })} className={k === tab ? "on" : ""} aria-current={k === tab ? "page" : undefined}>
                {v.label}
              </Link>
            ))}
          </Segmented>
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <div className={`inbox${sp.c || sp.t ? " has-open" : ""}`}>
        <aside className="inbox-list">
          <form className="inbox-tools">
            <input type="hidden" name="status" value={tab} />
            <label className="search">
              <Icon name="search" />
              <input name="q" defaultValue={sp.q ?? ""} placeholder="Search people and companies" aria-label="Search" />
            </label>
            <AutoSubmitSelect name="campaign" defaultValue={sp.campaign ?? ""} aria-label="Campaign">
              <option value="">All campaigns</option>
              {ctx.config.business.icp.segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {pretty(s.id)}
                </option>
              ))}
            </AutoSubmitSelect>
          </form>
          <div className="list-count">
            {count} {tab === "sent" ? "people emailed" : count === 1 ? "conversation" : "conversations"}
          </div>
          <div className="convo-list">
            {count === 0 && (
              <Empty icon={tab === "sent" ? "send" : "inbox"} title={tab === "needs" ? "You're all caught up" : "Nothing here yet"}>
                {tab === "sent" ? "Everyone we email shows up here." : tab === "needs" ? "Replies that need you land here, already read, sorted and drafted." : "Replies show up here as they arrive."}
              </Empty>
            )}
            {replyList.map(({ r, c, co, seg, hot }) => {
              const needs = !r.handled || r.draftState === "pending";
              const snippet = newReplyText(r.body).replace(/\s+/g, " ") || "(empty reply)";
              return (
                <Link key={r.id} href={href({ c: r.id })} className={`convo${r.id === sel?.id ? " on" : ""}${needs ? " unread" : ""}`}>
                  <span className={`avatar${hot ? " hot" : ""}`}>{initials(c ? name(c) : r.fromEmail)}</span>
                  <span className="body">
                    <span className="top">
                      <span className="who">{c ? name(c) : r.fromEmail}</span>
                      {hot && <Icon name="bars" size={14} className="signal" />}
                      <span className="when">{day(r.receivedAt)}</span>
                    </span>
                    <span className="sub">
                      {co?.name ?? r.fromEmail}
                      {seg ? ` · ${pretty(seg)}` : ""}
                    </span>
                    <span className="snip">{snippet}</span>
                    <span className="tags">
                      {hot && <span className="chip hot">Hot</span>}
                      {needs && <span className="chip needs">Needs reply</span>}
                      {!hot && !needs && <span className="chip">{STATUS_NAME[r.label ?? ""] ?? "New"}</span>}
                    </span>
                  </span>
                </Link>
              );
            })}
            {sentList.map(({ t, c, co, seg, last, n }) => {
              const st = sentState(c, t);
              return (
                <Link key={t.id} href={href({ t: t.id })} className={`convo${t.id === pickedSent?.t.id ? " on" : ""}`}>
                  <span className="avatar">{initials(name(c) || c.email)}</span>
                  <span className="body">
                    <span className="top">
                      <span className="who">{name(c) || c.email}</span>
                      <span className="when">{day(last)}</span>
                    </span>
                    <span className="sub">
                      {c.email}
                      {seg ? ` · ${pretty(seg)}` : ""}
                    </span>
                    <span className="tags">
                      <span className={`chip${st.tone ? ` ${st.tone}` : ""}`}>{st.label}</span>
                      <span className="small muted">
                        {n} {n === 1 ? "email" : "emails"} · {co.name}
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </aside>

        {threadId || sel ? (
          <article className="card flush thread rise" key={sel?.id ?? threadId ?? ""}>
            {/* Phones show the list or one conversation, not both; this goes back to the list. */}
            <Link className="thread-back" href={`/inbox?${new URLSearchParams(Object.entries({ status: sp.status, campaign: sp.campaign, q: sp.q }).filter((e): e is [string, string] => !!e[1])).toString()}`}>
              <Icon name="chevron" size={14} /> All conversations
            </Link>
            <header className="thread-head">
              <div className="person">
                <div className={`avatar${sel?.hot ? " hot" : ""}`}>{initials(who)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="name">
                    {who} {sel?.hot && <span className="chip hot">Hot</span>}
                  </div>
                  <div className="meta">{[person?.title, company?.name, person?.email].filter(Boolean).join(" · ")}</div>
                </div>
              </div>
              <div className="actions">
                {company && (
                  <Link href={`/leads/${company.id}`} className="btn sm">
                    <Icon name="info" size={14} /> Lead data
                  </Link>
                )}
                {sel && (
                  <>
                    {(!sel.handled || sel.draftState === "pending") && (
                      <form action={setReplyStatusAction}>
                        <input type="hidden" name="id" value={sel.id} />
                        <ConfirmButton className="sm" name="status" value="handled">
                          <Icon name="check" size={14} /> Mark as replied
                        </ConfirmButton>
                      </form>
                    )}
                    <details className="menu">
                      <summary className="btn sm">
                        Set status <Icon name="chevron" size={13} />
                      </summary>
                      <form action={setReplyStatusAction} className="menu-pop">
                        <input type="hidden" name="id" value={sel.id} />
                        <button name="status" value="hot">
                          <Icon name="flame" size={14} /> Hot lead
                        </button>
                        <button name="status" value="needs_reply">
                          <Icon name="reply" size={14} /> Needs reply
                        </button>
                        <button name="status" value="handled">
                          <Icon name="check" size={14} /> Handled
                        </button>
                        <button name="status" value="not_interested">
                          <Icon name="x" size={14} /> Not interested
                        </button>
                        <button name="status" value="stop" className="danger-soft">
                          <Icon name="power" size={14} /> Stop emailing them
                        </button>
                      </form>
                    </details>
                  </>
                )}
              </div>
            </header>

            {sel && (sel.summary || did) && (
              <div className="ai-read">
                <span className="ai-ico">
                  <Icon name="sparkle" size={14} />
                </span>
                <div className="ai-body">
                  <div className="ai-top">
                    <b>{STATUS_NAME[sel.label ?? ""] ?? "Unread"}</b>
                    {sel.confidence != null && <span className="muted small">{Math.round(sel.confidence * 100)}% sure</span>}
                  </div>
                  {nextStep && <div>{nextStep}</div>}
                  {asks && (
                    <div className="asks">
                      <Icon name="info" size={13} /> They asked: {asks}
                    </div>
                  )}
                  {did && (
                    <div className="did">
                      <Icon name={HANDOFF.includes(sel.label ?? "") ? "swap" : "check"} size={13} /> {did}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="thread-msgs">
              {timeline.map((t, i) =>
                t.ours ? (
                  <div key={`m${i}`} className="msg ours">
                    <div className="avatar">{initials(mb?.senderName ?? ctx.config.business.company.name)}</div>
                    <div className="bubble">
                      <div className="head">
                        <span className="name">{mb?.senderName ?? "Us"}</span>
                        <span className="addr">{mb?.email}</span>
                        <span className="time">{when(t.at)}</span>
                        <span className="ok" title="Delivered">
                          <Icon name="checks" size={14} />
                        </span>
                      </div>
                      {t.m.subject && <div className="subject">{t.m.subject}</div>}
                      <div className="text">{splitFooter(t.m.body)[0]}</div>
                      {mb && splitFooter(t.m.body)[1] && (
                        <div
                          className="email-sig"
                          // The mailbox's signature as the lead sees it (escaped fields, embedded logo).
                          dangerouslySetInnerHTML={{ __html: signatureHtml({ name: mb.senderName, title: mb.senderTitle, phone: mb.senderPhone }, ctx.config, "data") }}
                        />
                      )}
                      {splitFooter(t.m.body)[1] && (
                        <details className="sig">
                          <summary>Plain-text signature and footer</summary>
                          <div className="text footer">{splitFooter(t.m.body)[1]}</div>
                        </details>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={`r${i}`} className={`msg theirs${t.r.id === sel?.id ? " current" : ""}`}>
                    <div className="avatar">{initials(who || t.r.fromEmail)}</div>
                    <div className="bubble">
                      <div className="head">
                        <span className="name">{who || t.r.fromEmail}</span>
                        <span className="addr">{t.r.fromEmail}</span>
                        <span className="time">{when(t.at)}</span>
                      </div>
                      {t.r.subject && <div className="subject">{t.r.subject}</div>}
                      <div className="text">{newReplyText(t.r.body) || t.r.body.trim() || "(empty)"}</div>
                      {newReplyText(t.r.body) !== t.r.body.trim() && newReplyText(t.r.body) && (
                        <details className="sig">
                          <summary>Show full message</summary>
                          <div className="text footer">{t.r.body}</div>
                        </details>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>

            {mt && (
              <div className="meeting-bar">
                <Icon name="calendar" />
                <span className="strong">Demo</span>
                <Badge value={mt.stage === "hot" ? "not booked yet" : mt.stage} />
                {mt.bookedAt && <span className="small muted">{when(mt.bookedAt)}</span>}
                <span style={{ flex: 1 }} />
                {mt.stage === "hot" && (
                  <form action={book} className="row">
                    <input type="hidden" name="meetingId" value={mt.id} />
                    <input type="datetime-local" name="at" required aria-label="Demo time" />
                    <ConfirmButton className="sm primary">Book demo</ConfirmButton>
                  </form>
                )}
                {mt.stage !== "hot" && mt.stage !== "won" && mt.stage !== "lost" && (
                  <form action={meetingStage} className="row">
                    <input type="hidden" name="meetingId" value={mt.id} />
                    <ConfirmButton className="sm" name="stage" value="held">
                      Demo held
                    </ConfirmButton>
                    <ConfirmButton className="sm" name="stage" value="won">
                      Won
                    </ConfirmButton>
                    <ConfirmButton className="sm danger-soft" name="stage" value="lost">
                      Lost
                    </ConfirmButton>
                  </form>
                )}
              </div>
            )}

            {sel?.hot && sel.draftState !== "sent" && (
              <form action={setReplyStatusAction} className="hot-check">
                <input type="hidden" name="id" value={sel.id} />
                <Icon name="flame" size={15} />
                <span>We flagged this reply as a hot lead. Is that right?</span>
                <span style={{ flex: 1 }} />
                <button className="sm" name="status" value="hot">
                  Yes, hot lead
                </button>
                <button className="sm ghost" name="status" value="not_hot">
                  Not a hot lead
                </button>
              </form>
            )}
            {sel && HANDOFF.includes(sel.label ?? "") && (
              <div className="notice warn handoff">
                <Icon name="info" />
                <div>Prospect handed this off to a different contact. The new address is already added as a lead, so you usually don't need to reply here.</div>
              </div>
            )}
            {sel?.autoSendAt && sel.draftState === "pending" && (
              <div className="notice info auto-send">
                <Icon name="send" />
                <div>
                  <b>Sends automatically {sel.autoSendAt.getTime() <= now.getTime() ? "any moment now" : `at ${sel.autoSendAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TEAM_TZ })} PT (in ${until(sel.autoSendAt, now)})`}.</b> Edit and send it yourself, or hold it so it waits for you.
                </div>
                <form action={holdAutoReplyAction}>
                  <input type="hidden" name="id" value={sel.id} />
                  <button className="sm" type="submit">
                    Hold
                  </button>
                </form>
              </div>
            )}
            {sel?.threadId && sel.draftState !== "sent" ? (
              <Composer
                replyId={sel.id}
                sender={mb ? `${mb.senderName} <${mb.email}>` : "the sender"}
                draft={draftText ?? ""}
                cc={ctx.config.business.outreach.reply_cc}
                send={sendReply}
                draftWithAi={draftWithAiAction}
                discard={rejectDraft}
              />
            ) : sel ? (
              <div className="composer-done">
                <Icon name="checks" size={15} /> {sel.draftState === "sent" ? "Reply sent. Any answer shows up here." : "This message isn't linked to one of our threads, so reply from the mailbox directly."}
              </div>
            ) : (
              theirReplies.length > 0 && (
                <div className="composer-done">
                  <Link href={`/inbox?status=all&c=${theirReplies.at(-1)!.id}`}>
                    Open their reply to answer <Icon name="arrow" size={13} />
                  </Link>
                </div>
              )
            )}
          </article>
        ) : (
          <div className="thread-empty">
            <Empty icon="inbox" title="No conversation selected">
              Pick a conversation on the left to read the thread and answer it.
            </Empty>
          </div>
        )}
      </div>
    </>
  );
}

import { APP_NAME } from "./brand";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { HOUR, type Clock } from "./clock";
import type { Db } from "./db/client";
import { companies, contacts, events, replies } from "./db/schema";
import { recordEvent } from "./events";
import type { Logger } from "./log";
import { replyEmail } from "./reply-email";

/** An image carried inside an email (referenced as cid:...). */
export interface InlineImage {
  cid: string;
  filename: string;
  contentType: string;
  base64: string;
}
import { notifyRecipients, type NotifyKind } from "./team";

export type AlertLevel = "info" | "warn" | "critical";

export interface Alert {
  level: AlertLevel;
  /** Stable key used to de-duplicate repeats, e.g. "mailbox_paused:<id>". */
  key: string;
  title: string;
  body: string;
  /** How long the same key stays quiet after it fires (default an hour). A job broken overnight said so every hour (2026-11-04). */
  quietMs?: number;
}

export interface AlertSink {
  name: string;
  send(alert: Alert): Promise<void>;
}

export class ConsoleSink implements AlertSink {
  name = "console";
  constructor(private log: Logger) {}
  async send(a: Alert): Promise<void> {
    const fn = a.level === "critical" ? this.log.error : a.level === "warn" ? this.log.warn : this.log.info;
    fn.call(this.log, { alert: a.key }, `${a.title}: ${a.body}`);
  }
}

export class MemorySink implements AlertSink {
  name = "memory";
  alerts: Alert[] = [];
  async send(a: Alert): Promise<void> {
    this.alerts.push(a);
  }
}

export class SlackSink implements AlertSink {
  name = "slack";
  constructor(
    private webhookUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(a: Alert): Promise<void> {
    const icon = a.level === "critical" ? ":rotating_light:" : a.level === "warn" ? ":warning:" : ":information_source:";
    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `${icon} *${a.title}*\n${a.body}` }),
    });
    if (!res.ok) throw new Error(`slack webhook ${res.status}`);
  }
}

/** Phone push through ntfy (ntfy.sh or your own server). The topic acts as the address: keep it private. */
export class NtfySink implements AlertSink {
  name = "ntfy";
  constructor(
    private topic: string,
    private server = "https://ntfy.sh",
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(a: Alert): Promise<void> {
    const res = await this.fetchImpl(`${this.server.replace(/\/$/, "")}/${encodeURIComponent(this.topic)}`, {
      method: "POST",
      headers: { Title: `${APP_NAME}: ${a.title}`.slice(0, 200), Priority: a.level === "critical" ? "5" : a.level === "warn" ? "4" : "3", Tags: a.level === "critical" ? "rotating_light" : a.level === "warn" ? "warning" : "information_source" },
      body: a.body.slice(0, 1500),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }
}

export class EmailSink implements AlertSink {
  name = "email";
  constructor(
    private sendMail: (to: string[], subject: string, text: string) => Promise<unknown>,
    private to: string[],
  ) {}
  async send(a: Alert): Promise<void> {
    await this.sendMail(this.to, `[COE ${a.level}] ${a.title}`, a.body);
  }
}

/**
 * Email alerts to the team: each teammate chooses on the Settings page whether they get
 * hot leads, every reply, and/or problems. Sent one message per person from one of the sending mailboxes.
 */
export class TeamEmailSink implements AlertSink {
  name = "team_email";
  constructor(
    private db: Db,
    private sendMail: (to: string[], subject: string, text: string, opts?: { html?: string; fromName?: string; inline?: InlineImage[] }) => Promise<unknown>,
    private baseUrl?: string,
  ) {}

  /** The rich reply email (who, what they wrote, what we did, the draft), when the reply can be loaded. */
  private async replyMail(replyId: string, link: string | null) {
    const [row] = await this.db
      .select({ r: replies, c: contacts, co: companies })
      .from(replies)
      .leftJoin(contacts, eq(contacts.id, replies.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .where(eq(replies.id, replyId));
    if (!row) return null;
    const { r, c, co } = row;
    const [earlier] = r.threadId
      ? await this.db
          .select({ id: replies.id })
          .from(replies)
          .where(and(eq(replies.threadId, r.threadId), eq(replies.hot, true), lt(replies.receivedAt, r.receivedAt)))
          .limit(1)
      : [];
    return replyEmail({
      again: !!earlier,
      person: { firstName: c?.firstName ?? null, lastName: c?.lastName ?? null, title: c?.title ?? null, email: c?.email ?? r.fromEmail },
      company: co?.name ?? null,
      reply: { body: r.body, label: r.label, hot: r.hot, summary: r.summary, draftBody: r.draftBody, autoSendAt: r.autoSendAt },
      link,
    });
  }

  static kindOf(a: Alert): NotifyKind | null {
    if (a.key.startsWith("hot_lead:")) return "hot";
    if (a.key.startsWith("reply:")) return "replies";
    return a.level === "info" ? null : "problems";
  }

  async send(a: Alert): Promise<void> {
    const kind = TeamEmailSink.kindOf(a);
    if (!kind) return;
    const to = await notifyRecipients(this.db, kind);
    if (!to.length) return;
    const replyId = kind === "problems" ? null : a.key.split(":")[1];
    const base = this.baseUrl?.replace(/\/$/, "");
    const link = base ? (replyId ? `${base}/inbox?status=all&c=${replyId}` : base) : null;
    const rich = replyId && /^[0-9a-f-]{36}$/i.test(replyId) ? await this.replyMail(replyId, link) : null;
    if (rich) {
      for (const person of to) await this.sendMail([person], rich.subject, rich.text, { html: rich.html, fromName: APP_NAME, inline: rich.inline });
      return;
    }
    const subject = kind === "hot" ? `🔥 ${a.title}` : kind === "replies" ? a.title : `${APP_NAME} ${a.level === "critical" ? "needs attention" : "heads-up"}: ${a.title}`;
    const text = [
      a.body,
      link ? `\n${kind === "problems" ? `Open ${APP_NAME}` : "Open the conversation"}: ${link}` : "",
      `\n--\nYou get these because of your email settings in ${APP_NAME} (Settings > Email notifications).`,
    ].join("\n");
    for (const person of to) await this.sendMail([person], subject.slice(0, 180), text);
  }
}

/** Twilio SMS. Only critical alerts and hot leads go to SMS to keep it meaningful. */
export class SmsSink implements AlertSink {
  name = "sms";
  constructor(
    private opts: { accountSid: string; authToken: string; from: string; to: string[] },
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(a: Alert): Promise<void> {
    if (a.level !== "critical" && !a.key.startsWith("hot_lead:")) return;
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64");
    for (const to of this.opts.to) {
      const res = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ From: this.opts.from, To: to, Body: `COE: ${a.title}`.slice(0, 300) }),
        },
      );
      if (!res.ok) throw new Error(`twilio ${res.status}`);
    }
  }
}

export class Alerter {
  constructor(
    private db: Db,
    private sinks: AlertSink[],
    private clock: Clock,
    private log: Logger,
    private dedupeMs = HOUR,
  ) {}

  /** Sends to every sink unless the same key fired within the dedupe window. Never throws. */
  async notify(alert: Alert): Promise<boolean> {
    try {
      const since = new Date(this.clock.now().getTime() - (alert.quietMs ?? this.dedupeMs));
      const [dup] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.type, "alert"), gte(events.createdAt, since), sql`${events.data}->>'key' = ${alert.key}`));
      if ((dup?.n ?? 0) > 0) return false;
      await recordEvent(this.db, "alert", { data: { ...alert }, at: this.clock.now() });
    } catch (err) {
      this.log.error({ err }, "alert bookkeeping failed; sending anyway");
    }
    await Promise.all(
      this.sinks.map(async (s) => {
        try {
          await s.send(alert);
        } catch (err) {
          this.log.error({ err, sink: s.name }, "alert sink failed");
        }
      }),
    );
    return true;
  }
}

export function sinksFromEnv(
  channels: string[],
  env: NodeJS.ProcessEnv,
  log: Logger,
  extra: { email?: AlertSink; teamEmail?: AlertSink } = {},
): AlertSink[] {
  const sinks: AlertSink[] = [];
  for (const c of channels) {
    if (c === "console") sinks.push(new ConsoleSink(log));
    if (c === "slack" && env.SLACK_WEBHOOK_URL) sinks.push(new SlackSink(env.SLACK_WEBHOOK_URL));
    if (c === "ntfy" && env.NTFY_TOPIC) sinks.push(new NtfySink(env.NTFY_TOPIC, env.NTFY_SERVER));
    if (c === "email" && extra.email) sinks.push(extra.email);
    if (c === "team_email" && extra.teamEmail) sinks.push(extra.teamEmail);
    if (c === "sms" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.ALERT_SMS_TO) {
      sinks.push(
        new SmsSink({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          from: env.TWILIO_FROM,
          to: env.ALERT_SMS_TO.split(",").map((s) => s.trim()),
        }),
      );
    }
  }
  if (sinks.length === 0) sinks.push(new ConsoleSink(log));
  return sinks;
}

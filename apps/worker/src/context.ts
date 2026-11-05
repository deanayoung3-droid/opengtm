import {
  APP_NAME,
  Alerter,
  applyProjectDocs,
  createDb,
  createLlm,
  createLogger,
  decisionProvidersFromEnv,
  EmailSink,
  loadConfig,
  mailboxes as mailboxTable,
  loadProjectDocs,
  providersFromEnv,
  sinksFromEnv,
  systemClock,
  TeamEmailSink,
  type Config,
  type Ctx,
  type mailboxes, type InlineImage } from "@opengtm/core";
import { ImapSeedChecker } from "@opengtm/health";
import { PoliteFetcher } from "@opengtm/research";
import { NoopCrmSink, WebhookCrmSink, type CRMSink } from "@opengtm/replies";
import { FakeReader, FakeTransport, newMessageId, readerFor, transportFor, type MailReader, type MailTransport } from "@opengtm/sequencer";
import { DnsMxResolver, MockVerifier, StaticMxResolver, ZeroBounceVerifier, type MxResolver, type Verifier } from "@opengtm/verify";
import { asc, eq } from "drizzle-orm";
import nodemailer from "nodemailer";

type Mailbox = typeof mailboxes.$inferSelect;

/** Sender name, reply-to and an HTML version for internal email such as alerts. */
export interface InternalMailOpts {
  fromName?: string;
  replyTo?: string;
  html?: string;
  /** Images the HTML shows by cid:. */
  inline?: InlineImage[];
}

export interface Runtime {
  ctx: Ctx;
  /** business.yaml + engine.yaml as loaded, before project docs from the dashboard are applied. */
  baseConfig: Config;
  dryRun: boolean;
  transportFor: (mb: Mailbox) => MailTransport;
  readerFor: (mb: Mailbox) => MailReader;
  verifier: Verifier | null;
  mx: MxResolver;
  fetcher: PoliteFetcher;
  crm: CRMSink;
  seedChecker: ImapSeedChecker;
  /** Internal email (alerts, digests). False when there was nothing to send it from. */
  sendMail: (to: string[], subject: string, text: string, opts?: InternalMailOpts) => Promise<boolean>;
  publicBaseUrl?: string;
  unsubscribeSecret?: string;
  close: () => Promise<void>;
  /** Re-read the project docs edited in the dashboard and apply them over business.yaml. */
  refreshConfig: () => Promise<void>;
}

/**
 * Everything the worker and dashboard need, built from env + config.
 * GTM_DRY_RUN=1 swaps real mail transports and the paid verifier for fakes,
 * which is how the pilot is rehearsed before any mailbox is connected.
 */
export function buildRuntime(env: NodeJS.ProcessEnv = process.env, name = "worker"): Runtime {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const config = loadConfig({ env });
  const log = createLogger(name);
  const { db, close } = createDb(env.DATABASE_URL);
  const dryRun = env.GTM_DRY_RUN === "1";

  const fakeTransport = new FakeTransport();
  const fakeReader = new FakeReader();
  const mailTransport = (mb: Mailbox) => (dryRun ? fakeTransport : transportFor(mb, env, fakeTransport));

  const alertTo = (env.ALERT_EMAIL_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const smtp = env.ALERT_SMTP_URL ? nodemailer.createTransport(env.ALERT_SMTP_URL) : null;
  /** Internal email (alerts, digests): a dedicated SMTP if configured, otherwise the first active sending mailbox. */
  const sendMail = async (to: string[], subject: string, text: string, opts: InternalMailOpts = {}): Promise<boolean> => {
    if (to.length === 0) return false;
    if (smtp) {
      const address = env.ALERT_FROM ?? alertTo[0];
      const attachments = opts.inline?.map((i) => ({ cid: i.cid, filename: i.filename, contentType: i.contentType, content: Buffer.from(i.base64, "base64"), contentDisposition: "inline" as const }));
      await smtp.sendMail({ from: opts.fromName && address ? { name: opts.fromName, address } : address, to, subject, text, html: opts.html, replyTo: opts.replyTo, ...(attachments?.length ? { attachments } : {}) });
      return true;
    }
    const [mb] = await db.select().from(mailboxTable).where(eq(mailboxTable.status, "active")).orderBy(asc(mailboxTable.createdAt)).limit(1);
    if (!mb) {
      log.info({ subject }, "no active mailbox to send internal email from; not sent");
      return false;
    }
    for (const person of to) {
      await mailTransport(mb).send({
        from: { name: opts.fromName ?? APP_NAME, address: mb.email },
        replyTo: opts.replyTo ?? mb.email,
        to: person,
        subject,
        text,
        html: opts.html,
        ...(opts.html && opts.inline?.length ? { inline: opts.inline } : {}),
        messageId: newMessageId(mb.email),
        listUnsubscribe: { mailto: `mailto:${mb.email}?subject=unsubscribe` },
      });
    }
    return true;
  };
  const sinks = sinksFromEnv(config.engine.alerts.channels, env, log, {
    email: new EmailSink(sendMail, alertTo),
    teamEmail: new TeamEmailSink(db, sendMail, env.PUBLIC_BASE_URL),
  });
  const alerts = new Alerter(db, sinks, systemClock, log);
  const llm = createLlm({ db, config, providers: providersFromEnv(config.llm, env), decisionProviders: decisionProvidersFromEnv(config.llm, env), clock: systemClock, log });
  const ctx: Ctx = { db, config, llm, clock: systemClock, log, alerts, env, random: Math.random };

  const verifier: Verifier | null =
    dryRun || config.engine.verify.provider === "mock"
      ? new MockVerifier(0)
      : env.ZEROBOUNCE_API_KEY
        ? new ZeroBounceVerifier(env.ZEROBOUNCE_API_KEY, config.engine.verify.cost_per_check_usd)
        : null;

  return {
    ctx,
    baseConfig: config,
    dryRun,
    transportFor: mailTransport,
    readerFor: (mb) => (dryRun ? fakeReader : readerFor(mb, env, fakeReader)),
    verifier,
    mx: dryRun ? new StaticMxResolver({}, ["aspmx.l.google.com"]) : new DnsMxResolver(),
    fetcher: new PoliteFetcher({ userAgent: config.engine.research.user_agent, delayMs: config.engine.research.request_delay_ms }),
    crm: env.CRM_WEBHOOK_URL ? new WebhookCrmSink(env.CRM_WEBHOOK_URL) : new NoopCrmSink(),
    seedChecker: new ImapSeedChecker((inbox) => {
      const seed = config.engine.health.seed_inboxes.find((s) => s.address === inbox);
      const p = seed?.imap_env;
      if (!p || !env[`${p}_IMAP_HOST`]) return null;
      return { host: env[`${p}_IMAP_HOST`]!, port: Number(env[`${p}_IMAP_PORT`] ?? 993), user: env[`${p}_IMAP_USER`] ?? inbox, pass: env[`${p}_IMAP_PASS`] ?? "" };
    }),
    sendMail,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    unsubscribeSecret: env.UNSUBSCRIBE_SECRET,
    close,
    refreshConfig: async () => {
      try {
        ctx.config = applyProjectDocs(config, await loadProjectDocs(db));
      } catch (err) {
        log.error({ err }, "project docs are invalid; using business.yaml as is");
        ctx.config = config;
      }
    },
  };
}

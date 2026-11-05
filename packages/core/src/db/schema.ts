import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const segments = pgTable("segments", {
  id: text("id").primaryKey(),
  description: text("description").notNull(),
  status: text("status").$type<"active" | "paused">().notNull().default("active"),
  pausedReason: text("paused_reason"),
  updatedAt: updatedAt(),
});

export const companies = pgTable(
  "companies",
  {
    id: id(),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    website: text("website"),
    state: text("state"),
    city: text("city"),
    country: text("country").notNull().default("US"),
    companySize: integer("company_size"),
    focusAreas: jsonb("focus_areas").$type<string[]>().notNull().default([]),
    segmentId: text("segment_id").references(() => segments.id),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    icpScore: integer("icp_score"),
    icpReason: text("icp_reason"),
    signals: jsonb("signals").$type<string[]>().notNull().default([]),
    status: text("status")
      .$type<"new" | "qualified" | "disqualified" | "researching" | "researched" | "research_failed">()
      .notNull()
      .default("new"),
    researchedAt: timestamp("researched_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("companies_domain_uq").on(t.domain), index("companies_status_idx").on(t.status)],
);

export type ContactStatus =
  | "new"
  | "verified"
  | "dropped"
  | "enrolled"
  | "replied"
  | "completed"
  | "snoozed"
  | "suppressed"
  | "bounced";

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // always stored lowercased
    firstName: text("first_name"),
    lastName: text("last_name"),
    title: text("title"),
    role: text("role"),
    isRoleAddress: boolean("is_role_address").notNull().default(false),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    verifyStatus: text("verify_status")
      .$type<"pending" | "valid" | "invalid" | "catch_all" | "unknown" | "suppressed" | "no_mx">()
      .notNull()
      .default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    mailProvider: text("mail_provider").$type<"google" | "microsoft" | "other">(),
    status: text("status").$type<ContactStatus>().notNull().default("new"),
    dropReason: text("drop_reason"),
    retouchAt: timestamp("retouch_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contacts_email_uq").on(sql`lower(${t.email})`),
    index("contacts_company_idx").on(t.companyId),
    index("contacts_status_idx").on(t.status),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    kind: text("kind").$type<"about" | "team" | "services" | "news" | "careers" | "signal" | "other">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("facts_company_idx").on(t.companyId)],
);

export const sequences = pgTable("sequences", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: id(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    dayOffset: integer("day_offset").notNull(),
    variant: text("variant").notNull(), // "A" | "B" | "C"...
    instructions: text("instructions").notNull().default(""), // variant angle for the writer
    status: text("status").$type<"active" | "retired" | "proposed">().notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sequence_steps_uq").on(t.sequenceId, t.stepNumber, t.variant)],
);

export const campaigns = pgTable("campaigns", {
  id: id(),
  name: text("name").notNull(),
  segmentId: text("segment_id")
    .notNull()
    .references(() => segments.id),
  sequenceId: uuid("sequence_id")
    .notNull()
    .references(() => sequences.id),
  status: text("status").$type<"draft" | "active" | "paused">().notNull().default("active"),
  createdAt: createdAt(),
});

export const domains = pgTable("domains", {
  id: id(),
  name: text("name").notNull().unique(),
  status: text("status").$type<"active" | "paused" | "retired">().notNull().default("active"),
  pausedReason: text("paused_reason"),
  spfOk: boolean("spf_ok"),
  dkimOk: boolean("dkim_ok"),
  dmarcOk: boolean("dmarc_ok"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const mailboxes = pgTable("mailboxes", {
  id: id(),
  email: text("email").notNull().unique(),
  provider: text("provider").$type<"google" | "microsoft">().notNull(),
  transport: text("transport").$type<"gmail_api" | "graph" | "smtp" | "fake">().notNull(),
  domainId: uuid("domain_id")
    .notNull()
    .references(() => domains.id),
  senderName: text("sender_name").notNull(),
  senderTitle: text("sender_title"),
  /** Signature line "Title | C: phone"; blank = no phone shown. */
  senderPhone: text("sender_phone"),
  status: text("status").$type<"warming" | "active" | "paused" | "retired">().notNull().default("active"),
  pausedReason: text("paused_reason"),
  rampStartDate: timestamp("ramp_start_date", { withTimezone: true }).notNull().defaultNow(),
  dailyCapOverride: integer("daily_cap_override"),
  sentToday: integer("sent_today").notNull().default(0),
  sentTodayDate: text("sent_today_date"), // YYYY-MM-DD (UTC)
  nextSendAt: timestamp("next_send_at", { withTimezone: true }),
  healthScore: integer("health_score").notNull().default(100),
  credentialsEnv: text("credentials_env"), // prefix of env vars holding this mailbox's secrets
  /** SMTP/IMAP login from a bulk import, encrypted (see secrets.ts); used instead of credentials_env when set. */
  credentialsEnc: text("credentials_enc"),
  lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
  ingestCursor: text("ingest_cursor"),
  createdAt: createdAt(),
});

export const threads = pgTable(
  "threads",
  {
    id: id(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id),
    status: text("status").$type<"drafting" | "active" | "stopped" | "completed">().notNull().default("drafting"),
    stopReason: text("stop_reason"),
    subject: text("subject"),
    variant: text("variant").notNull().default("A"),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("threads_contact_campaign_uq").on(t.contactId, t.campaignId), index("threads_status_idx").on(t.status)],
);

export type ApprovalState = "pending" | "approved" | "rejected" | "auto_approved" | "needs_review";
export type MessageStatus = "draft" | "scheduled" | "sending" | "sent" | "failed" | "cancelled" | "unknown";

export const messages = pgTable(
  "messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"sequence" | "reply">().notNull().default("sequence"),
    stepNumber: integer("step_number").notNull(),
    dayOffset: integer("day_offset").notNull().default(0),
    variant: text("variant").notNull().default("A"),
    subject: text("subject").notNull(),
    body: text("body").notNull(), // full plain-text body including footer
    factIds: jsonb("fact_ids").$type<string[]>().notNull().default([]),
    proofPointIds: jsonb("proof_point_ids").$type<string[]>().notNull().default([]),
    promptVersion: text("prompt_version"),
    model: text("model"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    qaVerdict: jsonb("qa_verdict").$type<Record<string, unknown>>(),
    qaScore: integer("qa_score"),
    approvalState: text("approval_state").$type<ApprovalState>().notNull().default("pending"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    status: text("status").$type<MessageStatus>().notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id),
    rfcMessageId: text("rfc_message_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }), // set when locked for sending
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_rfc_uq").on(t.rfcMessageId),
    uniqueIndex("messages_thread_step_uq").on(t.threadId, t.kind, t.stepNumber),
    index("messages_status_idx").on(t.status, t.scheduledFor),
  ],
);

export const suppression = pgTable(
  "suppression",
  {
    id: id(),
    email: text("email"),
    domain: text("domain"),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("suppression_email_uq").on(t.email), uniqueIndex("suppression_domain_uq").on(t.domain)],
);

export type EventType =
  | "sent"
  | "bounced_hard"
  | "bounced_soft"
  | "replied"
  | "unsub"
  | "complaint"
  | "paused"
  | "resumed"
  | "retired"
  | "send_failed"
  | "send_unknown"
  | "suppressed"
  | "kill_switch"
  | "alert"
  | "digest"
  | "seed_result";

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").$type<EventType>().notNull(),
    contactId: uuid("contact_id"),
    messageId: uuid("message_id"),
    mailboxId: uuid("mailbox_id"),
    threadId: uuid("thread_id"),
    segmentId: text("segment_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("events_type_created_idx").on(t.type, t.createdAt), index("events_mailbox_idx").on(t.mailboxId, t.type)],
);

export const REPLY_LABELS = [
  "interested",
  "question",
  "objection",
  "not_now",
  "wrong_person",
  "referral",
  "out_of_office",
  "email_changed",
  "recipient_gone",
  "unsubscribe",
  "hostile",
  "bounce",
  "other",
] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];

export const replies = pgTable(
  "replies",
  {
    id: id(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id),
    fromEmail: text("from_email").notNull(),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    rfcMessageId: text("rfc_message_id"),
    label: text("label").$type<ReplyLabel>(),
    confidence: doublePrecision("confidence"),
    classifiedBy: text("classified_by"),
    actionTaken: text("action_taken"),
    hot: boolean("hot").notNull().default(false),
    summary: text("summary"),
    oooUntil: timestamp("ooo_until", { withTimezone: true }),
    draftBody: text("draft_body"),
    draftState: text("draft_state").$type<"none" | "pending" | "approved" | "sent" | "rejected">().notNull().default("none"),
    /** Auto-reply: the draft sends by itself at this time unless a person acts first. */
    autoSendAt: timestamp("auto_send_at", { withTimezone: true }),
    handled: boolean("handled").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("replies_rfc_uq").on(t.rfcMessageId), index("replies_label_idx").on(t.label)],
);

/** A one-page demo prep for a hot lead (written by the model from stored facts and the conversation only). */
export interface LeadBrief {
  headline: string;
  person: string[];
  /** Each point about the company, with the page it came from when it came from a researched fact. */
  company: { text: string; source: string | null }[];
  currentTools: string | null;
  showThem: { feature: string; why: string }[];
  questions: string[];
  watchOuts: string[];
  promptVersion: string;
}

export const meetings = pgTable("meetings", {
  id: id(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
  replyId: uuid("reply_id").references(() => replies.id, { onDelete: "set null" }),
  stage: text("stage").$type<"hot" | "booked" | "held" | "won" | "lost">().notNull().default("hot"),
  whyHot: text("why_hot"),
  nextStep: text("next_step"),
  brief: jsonb("brief").$type<LeadBrief>(),
  briefAt: timestamp("brief_at", { withTimezone: true }),
  bookedAt: timestamp("booked_at", { withTimezone: true }),
  crmSyncedAt: timestamp("crm_synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: id(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    ok: boolean("ok").notNull(),
    error: text("error"),
    companyId: uuid("company_id"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_company_idx").on(t.companyId), index("llm_calls_created_idx").on(t.createdAt)],
);

export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: id(),
    category: text("category").$type<"llm" | "verify" | "lead_data" | "mailbox" | "domain" | "other">().notNull(),
    amountUsd: doublePrecision("amount_usd").notNull(),
    companyId: uuid("company_id"),
    ref: text("ref"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("spend_created_idx").on(t.createdAt)],
);

export const seedTests = pgTable("seed_tests", {
  id: id(),
  mailboxId: uuid("mailbox_id")
    .notNull()
    .references(() => mailboxes.id, { onDelete: "cascade" }),
  seedInbox: text("seed_inbox").notNull(),
  seedProvider: text("seed_provider").notNull(),
  token: text("token").notNull().unique(),
  placement: text("placement").$type<"pending" | "inbox" | "spam" | "missing">().notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity"),
  entityId: text("entity_id"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

/**
 * The team: the people who get emailed about hot leads, replies and problems (Settings toggles per person).
 * Being on this list (status active) is what lets a signed-in person use the app; invites add rows.
 */
export const teamMembers = pgTable("team_members", {
  id: id(),
  email: text("email").notNull().unique(), // always stored lowercased
  name: text("name").notNull().default(""),
  status: text("status").$type<"active" | "removed">().notNull().default("active"),
  invitedBy: text("invited_by"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** Where their alert emails go, e.g. a work inbox other than the address on the team list. Null = that address. */
  alertEmail: text("alert_email"),
  /** Which emails this person gets: hot leads, every reply, problems (paused mailboxes, spend cap...). */
  notify: jsonb("notify").$type<{ hot: boolean; replies: boolean; problems: boolean }>().notNull().default({ hot: true, replies: false, problems: true }),
});

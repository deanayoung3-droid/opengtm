import { decryptLogin, mailboxes, messages, threads, type MailboxLogin } from "@opengtm/core";
import { createTestCtx, type TestCtx } from "@opengtm/core/testing";
import { AiArkSource, MemoryCursorStore, scoreCompany } from "@opengtm/leads";
import { giveUniqueNames, importInboxes, parseInboxCsv, parseRenames, readerFor, renameInboxes, retryFailedLogins, transportFor } from "@opengtm/sequencer";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../apps/worker/src/context";
import { buildJobs } from "../apps/worker/src/jobs";
import { seedCompany, seedMailbox, seedSequence } from "./fixtures";

const SECRET = { UNSUBSCRIBE_SECRET: "test-unsubscribe-secret-0123456789" };
const okLogin = async () => ({ smtp: "ok", imap: "ok", inboxMessages: 0 });

describe("bulk inbox import", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined as unknown as TestCtx;
  });

  it("reads vendor CSVs with or without a header, preferring the app password", () => {
    const withHeader = parseInboxCsv(
      [
        "First Name,Last Name,Email Address,Password,App Password,SMTP Host,SMTP Port,IMAP Host,IMAP Port",
        "Riley,Lee,Riley@mailbox-one.example,account-pw,abcd efgh ijkl mnop,smtp.gmail.com,465,imap.gmail.com,993",
        "Hailey,,hailey@mailbox-one.example,,wxyz wxyz wxyz wxyz,,,,",
        ",,,,secret,,,,",
        "Nina,Park,nina@mailbox-one.example,,,,,,",
      ].join("\n"),
    );
    expect(withHeader.inboxes.map((i) => [i.email, i.senderName, i.login.pass, i.login.smtpPort, i.login.imapHost])).toEqual([
      ["riley@mailbox-one.example", "Riley Lee", "abcdefghijklmnop", 465, "imap.gmail.com"],
      ["hailey@mailbox-one.example", "Hailey", "wxyzwxyzwxyzwxyz", 587, "imap.gmail.com"],
    ]);
    expect(withHeader.problems).toEqual(["Line 4: no email address", "Line 5 (nina@mailbox-one.example): no password"]);
    expect(withHeader.problems.join(" ")).not.toContain("secret"); // passwords never echoed back

    const bare = parseInboxCsv("riley_sales@mailbox-two.example,pw-1\r\nhailey.ross@mailbox-two.example,pw-2\r\n");
    expect(bare.inboxes.map((i) => [i.email, i.senderName, i.login.pass, i.login.smtpHost])).toEqual([
      ["riley_sales@mailbox-two.example", "Riley", "pw-1", "smtp.gmail.com"],
      ["hailey.ross@mailbox-two.example", "Hailey Ross", "pw-2", "smtp.gmail.com"],
    ]);
  });

  it("drops vendors' placeholder last names and capitalizes lowercase names", async () => {
    const { inboxes } = parseInboxCsv("First Name,Last Name,Email,App Password\ndaniela,Last,daniela@mailbox-three.example,pw\nMARY ANN,,mary@mailbox-three.example,pw\nJo,McKay,jo@mailbox-three.example,pw\n");
    expect(inboxes.map((i) => i.senderName)).toEqual(["Daniela", "Mary Ann", "Jo McKay"]);

  });

  it("tests each login, stores it encrypted, and sends and reads with it", async () => {
    ctx = await createTestCtx({ start: "2026-11-02T17:00:00Z" });
    ctx.env = { ...SECRET };
    const { inboxes } = parseInboxCsv("email,app password,first name\na@one.example,good-pass,Ana\nb@one.example,bad-pass,Bea\n");
    const check = async (l: MailboxLogin) => (l.pass === "good-pass" ? okLogin() : { smtp: "wrong address or app password (Google rejected the login)", imap: "not checked" });

    const results = await importInboxes(ctx, inboxes, { actor: "test", check });
    expect(results).toEqual([
      { email: "a@one.example", result: "added", ok: true, reason: undefined },
      { email: "b@one.example", result: "added", ok: false, reason: "sending: wrong address or app password (Google rejected the login)" },
    ]);
    const rows = await ctx.db.select().from(mailboxes);
    const a = rows.find((r) => r.email === "a@one.example")!;
    const b = rows.find((r) => r.email === "b@one.example")!;
    expect(a).toMatchObject({ status: "active", transport: "smtp", provider: "google", senderName: "Ana", credentialsEnv: null });
    expect(a.rampStartDate.toISOString()).toBe("2026-11-02T17:00:00.000Z"); // first ramp tier from today
    expect(b).toMatchObject({ status: "paused", pausedReason: "Login failed when imported: sending: wrong address or app password (Google rejected the login)" });
    expect(a.credentialsEnc).not.toContain("good-pass");
    expect(decryptLogin(a.credentialsEnc!, ctx.env)).toMatchObject({ user: "a@one.example", pass: "good-pass", smtpHost: "smtp.gmail.com", smtpPort: 587 });
    expect(() => decryptLogin(a.credentialsEnc!, { UNSUBSCRIBE_SECRET: "another-secret-entirely-xyz" })).toThrow(/import the inbox CSV again/);

    // The stored login is what sending and reading use; no MBn_* settings needed.
    const smtp = transportFor(a, ctx.env) as unknown as { t: { options: { host: string; auth: { user: string; pass: string } } } };
    expect(smtp.t.options).toMatchObject({ host: "smtp.gmail.com", auth: { user: "a@one.example", pass: "good-pass" } });
    expect((readerFor(a, ctx.env) as unknown as { opts: object }).opts).toMatchObject({ host: "imap.gmail.com", port: 993, user: "a@one.example", pass: "good-pass" });

    // Importing again with the right password fixes the paused one; the active one keeps its ramp.
    await ctx.db.update(mailboxes).set({ sentToday: 7 }).where(eq(mailboxes.id, a.id));
    const again = await importInboxes(ctx, parseInboxCsv("email,app password\na@one.example,good-pass\nb@one.example,good-pass\n").inboxes, { actor: "test", check });
    expect(again.map((r) => [r.email, r.result, r.ok])).toEqual([
      ["a@one.example", "updated", true],
      ["b@one.example", "updated", true],
    ]);
    const after = await ctx.db.select().from(mailboxes);
    expect(after.find((r) => r.email === "b@one.example")).toMatchObject({ status: "active", pausedReason: null, senderName: "Bea" });
    expect(after.find((r) => r.email === "a@one.example")).toMatchObject({ sentToday: 7, rampStartDate: a.rampStartDate });

    // A later file with a wrong password leaves a working inbox exactly as it was.
    const goodLogin = after.find((r) => r.email === "a@one.example")!.credentialsEnc;
    const [bad] = await importInboxes(ctx, parseInboxCsv("email,password\na@one.example,account-password\n").inboxes, { actor: "test", check });
    expect(bad).toMatchObject({ email: "a@one.example", ok: false, reason: expect.stringContaining("kept its current login") });
    const [kept] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, "a@one.example"));
    expect(kept).toMatchObject({ status: "active", credentialsEnc: goodLogin });
  });

  it("tries failed logins again every hour and switches the inbox on once Google accepts it", async () => {
    ctx = await createTestCtx({ start: "2026-11-02T17:00:00Z" });
    ctx.env = { ...SECRET };
    const rejected = { smtp: "wrong address or app password (Google rejected the login)", imap: "not checked" };
    await importInboxes(ctx, parseInboxCsv("email,app password\nmary@mailbox-one.example,pw\n").inboxes, { actor: "test", check: async () => rejected });
    await seedMailbox(ctx, { email: "other@outreach-mail.example", status: "paused" }); // paused for another reason: left alone
    const sendFail = await seedMailbox(ctx, { email: "sendfail@outreach-mail.example", status: "paused" });
    await ctx.db.update(mailboxes).set({ pausedReason: "authentication failed: Invalid login: 535-5.7.8", credentialsEnc: (await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, "mary@mailbox-one.example")))[0]!.credentialsEnc }).where(eq(mailboxes.id, sendFail.id));

    let googleAccepts = false;
    const check = async () => (googleAccepts ? okLogin() : rejected);
    expect(await retryFailedLogins(ctx, { check })).toEqual({ tried: 2, resumed: [] });
    const [still] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, "mary@mailbox-one.example"));
    expect(still).toMatchObject({ status: "paused", pausedReason: expect.stringContaining("trying again every hour") });
    expect(ctx.sink.alerts.filter((a) => a.key.startsWith("mailbox_login:"))).toHaveLength(0); // too early to bother anyone

    // Three days on and still refused: one alert.
    ctx.clock.advance(3 * 86_400_000);
    await retryFailedLogins(ctx, { check });
    expect(ctx.sink.alerts.filter((a) => a.key.startsWith("mailbox_login:")).map((a) => a.title)).toContain("Inbox still can't log in: mary@mailbox-one.example");
    // The hourly retries that follow don't repeat it (they emailed every hour on 2026-11-04).
    for (let h = 0; h < 6; h++) {
      ctx.clock.advance(3_600_000);
      await retryFailedLogins(ctx, { check });
    }
    expect(ctx.sink.alerts.filter((a) => a.title === "Inbox still can't log in: mary@mailbox-one.example")).toHaveLength(1);

    googleAccepts = true;
    expect((await retryFailedLogins(ctx, { check })).resumed.sort()).toEqual(["mary@mailbox-one.example", "sendfail@outreach-mail.example"]);
    const rows = await ctx.db.select().from(mailboxes);
    expect(rows.find((r) => r.email === "mary@mailbox-one.example")).toMatchObject({ status: "active", pausedReason: null });
    expect(rows.find((r) => r.email === "other@outreach-mail.example")).toMatchObject({ status: "paused" });
  });

  it("gives inboxes that share a name their own last names, except ones that already emailed someone", async () => {
    ctx = await createTestCtx();
    const { campaign } = await seedSequence(ctx);
    const inbox = async (email: string, name: string) => {
      const m = await seedMailbox(ctx, { email });
      await ctx.db.update(mailboxes).set({ senderName: name }).where(eq(mailboxes.id, m.id));
      return m;
    };
    const old = await inbox("mary_sales@ace.example", "Mary");
    await inbox("mary@one.example", "Mary");
    await inbox("mary@two.example", "Mary");
    await inbox("riley@one.example", "Riley");
    await inbox("jordan@one.example", "Jordan Collins"); // already has a last name, which is then taken
    // The old Mary already emailed a company: her name stays.
    const f = await seedCompany(ctx);
    const [t] = await ctx.db.insert(threads).values({ contactId: f.contact.id, companyId: f.company.id, campaignId: campaign.id, mailboxId: old.id, status: "active" }).returning();
    await ctx.db.insert(messages).values({ threadId: t!.id, contactId: f.contact.id, stepNumber: 1, subject: "s", body: "b", status: "sent", sentAt: ctx.clock.now() });

    expect(await giveUniqueNames(ctx)).toEqual([
      { email: "mary@one.example", name: "Mary Reyes" },
      { email: "mary@two.example", name: "Mary Parker" },
    ]);
    const names = (await ctx.db.select().from(mailboxes)).map((m) => m.senderName).sort();
    expect(names).toEqual(["Jordan Collins", "Mary", "Mary Parker", "Mary Reyes", "Riley"]);
    expect(await giveUniqueNames(ctx)).toEqual([]); // nothing left to do
  });

  it("moves an inbox to the address it was renamed to, keeping its ramp, threads and password", async () => {
    ctx = await createTestCtx({ start: "2026-11-02T17:00:00Z" });
    ctx.env = { ...SECRET };
    const { campaign } = await seedSequence(ctx);
    let googleKnowsNewName = false;
    const tried: string[] = [];
    const check = async (l: MailboxLogin) => {
      tried.push(`${l.user}:${l.pass}`);
      return l.user.startsWith("allison") && !googleKnowsNewName ? { smtp: "wrong address or app password (Google rejected the login)", imap: "not checked" } : okLogin();
    };
    await importInboxes(ctx, parseInboxCsv("email,app password\nmary@mailbox-four.example,pw-1\nbrooke_sales@mailbox-four.example,pw-2\n").inboxes, { actor: "test", check });
    const [mary] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.email, "mary@mailbox-four.example"));
    const f = await seedCompany(ctx);
    await ctx.db.insert(threads).values({ contactId: f.contact.id, companyId: f.company.id, campaignId: campaign.id, mailboxId: mary!.id, status: "drafting" });

    const { pairs, problems } = parseRenames("Mary@mailbox-four.example, allison_sales@mailbox-four.example\nx@mailbox-four.example -> y@other.example\nnobody@mailbox-four.example,z@mailbox-four.example\n");
    expect(problems).toEqual(["Line 2: x@mailbox-four.example and y@other.example are on different domains"]);

    // Google hasn't caught up with the new name yet: the inbox waits paused (and the hourly retry picks it up).
    let res = await renameInboxes(ctx, pairs, { actor: "test", check });
    expect(res.map((r) => [r.to, r.ok, r.reason])).toEqual([
      ["allison_sales@mailbox-four.example", false, "sending: wrong address or app password (Google rejected the login)"],
      ["z@mailbox-four.example", false, "no inbox with that address"],
    ]);
    let [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mary!.id));
    expect(row).toMatchObject({ email: "allison_sales@mailbox-four.example", senderName: "Allison", status: "paused", rampStartDate: mary!.rampStartDate });
    expect(decryptLogin(row!.credentialsEnc!, ctx.env)).toMatchObject({ user: "allison_sales@mailbox-four.example", pass: "pw-1" });
    expect((await ctx.db.select().from(threads)).map((t) => t.mailboxId)).toEqual([mary!.id]); // same inbox, same threads

    googleKnowsNewName = true;
    expect(await retryFailedLogins(ctx, { check })).toEqual({ tried: 1, resumed: ["allison_sales@mailbox-four.example"] });
    res = await renameInboxes(ctx, [{ from: "mary@mailbox-four.example", to: "allison_sales@mailbox-four.example" }], { actor: "test", check });
    expect(res[0]).toMatchObject({ ok: false, reason: "already renamed" }); // pasting the list twice is harmless
    [row] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mary!.id));
    expect(row).toMatchObject({ status: "active", pausedReason: null });
  });

  it("refuses to import without a key to encrypt with", async () => {
    ctx = await createTestCtx();
    ctx.env = {};
    await expect(importInboxes(ctx, parseInboxCsv("a@one.example,pw").inboxes, { actor: "test", check: okLogin })).rejects.toThrow(/MAILBOX_SECRET_KEY/);
    expect(await ctx.db.select().from(mailboxes)).toHaveLength(0);
  });
});

describe("wider lead search", () => {
  let ctx: TestCtx;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined as unknown as TestCtx;
  });

  it("searches technician titles after the ICP roles and starts a new search version from the first page", async () => {
    const calls: { path: string; body: any }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const path = new URL(String(url)).pathname;
      calls.push({ path, body });
      if (path.endsWith("/people/preview")) {
        const p = (id: string, title: string) => ({ id, profile: { title }, company: { id: "F1", summary: { name: "Oak Cleaning" } }, location: { country: "United States" } });
        return new Response(JSON.stringify({ content: [p("x1", "Technician"), p("x2", "Lead Technician"), p("x3", "Office Manager")], totalPages: 1 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const cursor = new MemoryCursorStore();
    await cursor.set("ai_ark:preview:cleaning", 40); // how far the narrower search had got
    const src = new AiArkSource({ apiKey: "k", termsAllowOutbound: true, maxCreditsPerRun: 10, maxExportsPerCompany: 3, employeeMin: 1, employeeMax: 50, industries: [], cursor, fetchImpl, sleep: async () => {}, preview: true, extraTitles: ["technician", "Owner"], searchVersion: 2 });
    await src.discoverCompanies({ segmentId: "cleaning", keywords: ["cleaning"], roles: ["owner", "office manager"], limit: 5 });

    const search = calls[0]!;
    expect(search.body.page).toBe(0); // not page 40: the wider filter's results are all new
    expect(search.body.contact.experience.latest.title.any.include.content).toEqual(["owner", "office manager", "technician"]);
    expect(search.body.account.employeeSize.range).toEqual([{ start: 1, end: 50 }]);
    // The office manager (an ICP role) is looked up before the technicians.
    expect(calls.filter((c) => c.path.endsWith("/export/single")).map((c) => c.body.id)).toEqual(["x3", "x1", "x2"]);
    expect(await cursor.get("ai_ark:preview:v2:cleaning")).toBe(1);
    expect(await cursor.get("ai_ark:preview:cleaning")).toBe(40); // the old position is left alone
  });

  it("keeps companies of up to max_company_size people", async () => {
    ctx = await createTestCtx();
    const company = (companySize: number) => scoreCompany(ctx.config, { country: "US", state: "TX", companySize, focusAreas: ["cleaning"], name: "Oak Cleaning", signals: [] } as never);
    ctx.config.engine.qualify.max_company_size = 50;
    expect(company(35).hardFail).toBeUndefined();
    expect(company(35).score).toBeGreaterThanOrEqual(ctx.config.engine.qualify.threshold);
    expect(company(35).score).toBeLessThan(company(5).score); // smaller companies still rank first
    expect(company(51)).toMatchObject({ hardFail: "too_large", reason: "company too large (51 people)" });
  });

  it("each discover run asks every campaign for an even share of what the mailboxes need", async () => {
    ctx = await createTestCtx({ start: "2026-11-02T15:00:00Z" });
    ctx.env = { AI_ARK_API_KEY: "k", AI_ARK_TERMS_OK: "1" };
    await seedSequence(ctx);
    // 4 mailboxes past their ramp (35/day each, 140) with a 4-step test sequence: 35 new people a day, 3 days stocked.
    for (let i = 0; i < 4; i++) await seedMailbox(ctx, { email: `m${i}@outreach-mail.example`, rampStart: new Date("2026-08-01T00:00:00Z") });
    for (let i = 0; i < 5; i++) await seedCompany(ctx); // already waiting
    const limits: number[] = [];
    const orig = AiArkSource.prototype.discoverCompanies;
    AiArkSource.prototype.discoverCompanies = async function (q) {
      limits.push(q.limit);
      return [];
    };
    try {
      const rt = { ctx, dryRun: false, fetcher: {} } as unknown as Runtime;
      await buildJobs(rt).discover!.run();
    } finally {
      AiArkSource.prototype.discoverCompanies = orig;
    }
    const campaigns = ctx.config.business.icp.segments.length;
    expect(limits).toHaveLength(campaigns);
    // (35 x 3 - 5 waiting) x 1.2 spread over the campaigns, never above the per-campaign ceiling.
    expect(limits[0]).toBe(Math.min(ctx.config.engine.leads.companies_per_segment_per_run, Math.ceil((100 * 1.2) / campaigns)));
  });
});

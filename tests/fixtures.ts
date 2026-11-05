import {
  campaigns,
  companies,
  contacts,
  domains,
  facts,
  mailboxes,
  segments,
  sequences,
  sequenceSteps,
  threads,
  type Ctx,
} from "@opengtm/core";

export const STEP_INSTRUCTIONS = [
  "Open with one specific observation about the company, then connect it to one Northwind strength.",
  "Short follow-up adding a different angle. Do not repeat step 1.",
  "Offer a quick look at how Northwind handles billing; may include the booking link.",
  "Brief, polite break-up. No pressure.",
];

export async function seedSequence(ctx: Ctx, segmentId = "hvac") {
  for (const s of ctx.config.business.icp.segments) {
    await ctx.db.insert(segments).values({ id: s.id, description: s.description }).onConflictDoNothing();
  }
  const [seq] = await ctx.db.insert(sequences).values({ name: "default" }).returning();
  const steps = ctx.config.engine.sequence.steps;
  for (const variant of ["A", "B"]) {
    await ctx.db.insert(sequenceSteps).values(
      steps.map((s, i) => ({ sequenceId: seq!.id, stepNumber: s.step, dayOffset: s.day, variant, instructions: STEP_INSTRUCTIONS[i] ?? "" })),
    );
  }
  const [campaign] = await ctx.db.insert(campaigns).values({ name: `${segmentId} default`, segmentId, sequenceId: seq!.id }).returning();
  return { sequence: seq!, campaign: campaign! };
}

export async function seedMailbox(
  ctx: Ctx,
  opts: { email?: string; domain?: string; provider?: "google" | "microsoft"; rampStart?: Date; status?: "active" | "warming" | "paused" } = {},
) {
  const domainName = opts.domain ?? "outreach-mail.example";
  await ctx.db.insert(domains).values({ name: domainName }).onConflictDoNothing();
  const [d] = await ctx.db.select().from(domains).where((await import("drizzle-orm")).eq(domains.name, domainName));
  const [m] = await ctx.db
    .insert(mailboxes)
    .values({
      email: opts.email ?? `jamie@${domainName}`,
      provider: opts.provider ?? "google",
      transport: "fake",
      domainId: d!.id,
      senderName: "Jamie Rivera",
      senderTitle: "Co-founder",
      status: opts.status ?? "active",
      rampStartDate: opts.rampStart ?? ctx.clock.now(),
    })
    .returning();
  return m!;
}

let companySeq = 0;

export async function seedCompany(
  ctx: Ctx,
  opts: { state?: string; withFacts?: boolean; provider?: "google" | "microsoft" | "other"; segmentId?: string; contacts?: number } = {},
) {
  companySeq++;
  const domain = `company${companySeq}-${Math.floor(ctx.random() * 1e6)}.biz.example`;
  const [company] = await ctx.db
    .insert(companies)
    .values({
      domain,
      name: `Company ${companySeq} Heating & Air`,
      website: `https://${domain}`,
      state: opts.state ?? "TX",
      city: "Austin",
      companySize: 4,
      focusAreas: ["hvac"],
      segmentId: opts.segmentId ?? "hvac",
      source: "test",
      status: "researched",
      icpScore: 90,
    })
    .returning();
  const people = [];
  for (let i = 0; i < (opts.contacts ?? 1); i++) {
    const [c] = await ctx.db
      .insert(contacts)
      .values({
        companyId: company!.id,
        email: `${i === 0 ? "ana" : `p${i}`}@${domain}`,
        firstName: i === 0 ? "Ana" : `P${i}`,
        title: i === 0 ? "General Manager" : "Associate",
        role: i === 0 ? "general manager" : null,
        source: "test",
        status: "verified",
        verifyStatus: "valid",
        mailProvider: opts.provider ?? "google",
      })
      .returning();
    people.push(c!);
  }
  const factRows =
    opts.withFacts === false
      ? []
      : await ctx.db
          .insert(facts)
          .values([
            { companyId: company!.id, text: "Company was founded in 2009 by Ana Rivera", sourceUrl: `https://${domain}/about`, fetchedAt: ctx.clock.now(), kind: "about" as const },
            { companyId: company!.id, text: "The company is hiring a full-time dispatcher in Austin", sourceUrl: `https://${domain}/careers`, fetchedAt: ctx.clock.now(), kind: "signal" as const },
          ])
          .returning();
  return { company: company!, contact: people[0]!, contacts: people, facts: factRows };
}

export async function seedThread(ctx: Ctx, opts: { withFacts?: boolean } = {}) {
  const { campaign } = await seedSequence(ctx);
  const mailbox = await seedMailbox(ctx);
  const company = await seedCompany(ctx, { withFacts: opts.withFacts });
  const [thread] = await ctx.db
    .insert(threads)
    .values({ contactId: company.contact.id, companyId: company.company.id, campaignId: campaign.id, mailboxId: mailbox.id, variant: "A" })
    .returning();
  return { ...company, campaign, mailbox, thread: thread! };
}

/** A well-formed body: 60ish words, exactly one question, no links or numbers. */
export function goodBody(step: number, extra = ""): string {
  const lines = [
    "Hi Ana,",
    "I noticed your company is growing its team in Austin, and that usually means more time spent on scheduling, dispatch and chasing invoices.",
    `Northwind is simple scheduling software built for small service teams like yours, with scheduling and reminders that stay out of the way. ${extra}`,
    step === 4 ? "Should I stop reaching out about this?" : "Would it be worth a short conversation to see if it fits how you work?",
  ];
  return lines.join("\n\n");
}

export function goodDraft(factIds: string[] = ["f2"], overrides: Partial<Record<number, string>> = {}) {
  return {
    subject: "scheduling at your company",
    steps: [1, 2, 3, 4].map((step) => ({
      step,
      body: overrides[step] ?? goodBody(step),
      fact_ids: step === 1 ? factIds : [],
      proof_point_ids: step === 2 ? ["pp1"] : [],
    })),
  };
}

export const passingCritic = () => ({ score: 86, problems: [] });

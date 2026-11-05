import { companies, contacts, spendLedger, suppress, suppression } from "@opengtm/core";
import { createTestCtx, type TestCtx } from "@opengtm/core/testing";
import { MockVendorSource, runDiscover, runQualify } from "@opengtm/leads";
import { MockVerifier, runVerify, StaticMxResolver } from "@opengtm/verify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const seg = "hvac";
const domainFor = (last: string, i: number) => `${last}${i}-hvac.biz.example`;

describe("Discover -> Qualify -> Verify (acceptance: 50 sample companies)", () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await createTestCtx();
  });
  afterEach(async () => ctx.close());

  it("flows end to end; suppressed, invalid, role, non-US and oversized are dropped", async () => {
    // Pre-existing suppression: one whole company domain and one person.
    await suppress(ctx.db, { domain: domainFor("patel", 2) }, "requested", "test");
    await suppress(ctx.db, { email: `james@${domainFor("nguyen", 1)}` }, "unsubscribed", "test");

    const discovered = await runDiscover(ctx, [new MockVendorSource(50)], { segmentId: seg, limitPerSegment: 50 });
    expect(discovered.skipped.non_us).toBe(5);
    expect(discovered.skipped.suppressed_domain).toBe(1);
    expect(discovered.skipped.suppressed_email).toBe(1);
    expect(discovered.skipped.duplicate_email).toBeGreaterThan(0); // upper-cased duplicate emails
    expect(discovered.companiesNew).toBe(44);

    // Re-running discovery is idempotent.
    const again = await runDiscover(ctx, [new MockVendorSource(50)], { segmentId: seg, limitPerSegment: 50 });
    expect(again.companiesNew).toBe(0);
    expect(again.contactsNew).toBe(0);

    const q = await runQualify(ctx);
    expect(q).toEqual({ qualified: 37, disqualified: 7 });
    const large = await ctx.db.select().from(companies).where(eq(companies.status, "disqualified"));
    expect(large.every((c) => c.icpReason?.includes("too large"))).toBe(true);

    // A contact suppressed between discovery and verification must not be verified.
    await suppress(ctx.db, { email: `aisha@${domainFor("okafor", 4)}` }, "unsubscribed", "test");

    const verifier = new MockVerifier(0.008);
    const v = await runVerify(ctx, { verifier, mx: new StaticMxResolver({}, ["aspmx.l.google.com"]) }, 500);
    expect(v.verified).toBe(31);
    expect(v.dropped.verifier_invalid).toBe(4);
    expect(v.dropped.role_address_not_allowed).toBeGreaterThan(0);

    const all = await ctx.db.select().from(contacts);
    const verified = all.filter((c) => c.status === "verified");
    const suppressedRows = await ctx.db.select().from(suppression);
    const supEmails = new Set(suppressedRows.map((s) => s.email).filter(Boolean));
    const supDomains = new Set(suppressedRows.map((s) => s.domain).filter(Boolean));

    for (const c of verified) {
      expect(supEmails.has(c.email)).toBe(false);
      expect(supDomains.has(c.email.split("@")[1]!)).toBe(false);
      expect(c.email.startsWith("invalid")).toBe(false);
      expect(c.isRoleAddress).toBe(false);
      expect(c.mailProvider).toBe("google");
      expect(c.source).toBe("mock_vendor");
    }
    // Emails are unique case-insensitively.
    expect(new Set(all.map((c) => c.email.toLowerCase())).size).toBe(all.length);
    // We never paid to verify suppressed, role, or disqualified-company contacts.
    expect(verifier.checked.some((e) => supEmails.has(e))).toBe(false);
    expect(verifier.checked.some((e) => e.startsWith("info@"))).toBe(false);
    expect(verifier.checked.some((e) => /(alvarez|nguyen|patel|brooks|okafor|kim|russo|bennett|cohen|hart)(6|13|20|27|34|41|48)-/.test(e))).toBe(false);
    // Each check was recorded as spend.
    const spend = await ctx.db.select().from(spendLedger);
    expect(spend.filter((s) => s.category === "verify")).toHaveLength(verifier.checked.length);
  });

  it("does nothing for sources not cleared for outbound use", async () => {
    const src = new MockVendorSource(5);
    Object.defineProperty(src, "termsAllowOutbound", { value: false });
    const stats = await runDiscover(ctx, [src], { segmentId: seg });
    expect(stats.companiesNew).toBe(0);
    expect(stats.skipped.source_terms).toBe(1);
  });

  it("do-not-mail verifier results are suppressed permanently", async () => {
    await runDiscover(ctx, [new MockVendorSource(1)], { segmentId: seg });
    await runQualify(ctx);
    const [c] = await ctx.db.select().from(contacts);
    await ctx.db.update(contacts).set({ email: `trap@${c!.email.split("@")[1]}` }).where(eq(contacts.id, c!.id));
    await runVerify(ctx, { verifier: new MockVerifier(), mx: new StaticMxResolver({}) });
    const sup = await ctx.db.select().from(suppression);
    expect(sup.map((s) => s.email)).toContain(`trap@${c!.email.split("@")[1]}`);
  });
});

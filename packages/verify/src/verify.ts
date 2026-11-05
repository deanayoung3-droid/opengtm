import {
  assertDailySpendOk,
  companies,
  contacts,
  domainOf,
  isSuppressed,
  isValidEmailSyntax,
  recordSpend,
  SpendCapError,
  startOfTeamDay,
  suppress,
  type Ctx,
} from "@opengtm/core";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { providerFromMx, type MxResolver } from "./mx";
import { VerifierUnavailableError, type Verifier } from "./types";

export interface VerifyDeps {
  /** Paid verifier (ZeroBounce). Null = only sources listed in verify.trust_sources can pass. */
  verifier: Verifier | null;
  mx: MxResolver;
}

export interface VerifyStats {
  verified: number;
  dropped: Record<string, number>;
  deferred: number;
}

/**
 * Verify: suppression -> syntax -> role-address policy -> MX -> verifier API.
 * Only `valid` survives. Contacts from a source in verify.trust_sources (AI Ark already verified the
 * address before charging for it) get ZeroBounce as a second opinion when it is set up: an address it
 * says will bounce is dropped, but catch-all and unknown keep the source's verdict, and if ZeroBounce is
 * missing, out of credits or over the spend cap they pass on the source's word. Runs on contacts of
 * qualified companies only, so we never pay to verify people we would not email.
 */
export async function runVerify(ctx: Ctx, deps: VerifyDeps, limit = 100): Promise<VerifyStats> {
  const { caps, verify: vcfg } = ctx.config.engine;
  const stats: VerifyStats = { verified: 0, dropped: {}, deferred: 0 };
  const now = ctx.clock.now();

  const rows = await ctx.db
    .select({ contact: contacts })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.status, "new"), inArray(companies.status, ["qualified", "researching", "researched"])))
    .limit(limit);

  const [roleToday] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.isRoleAddress, true), eq(contacts.status, "verified"), gte(contacts.verifiedAt, startOfTeamDay(now))));
  let roleBudget = caps.role_address_daily_cap - (roleToday?.n ?? 0);

  const drop = async (id: string, reason: string, verifyStatus?: typeof contacts.$inferSelect.verifyStatus) => {
    stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
    await ctx.db
      .update(contacts)
      .set({ status: "dropped", dropReason: reason, ...(verifyStatus ? { verifyStatus } : {}), updatedAt: now })
      .where(eq(contacts.id, id));
  };

  let verifierDown = false;
  for (const { contact: c } of rows) {
    if (await isSuppressed(ctx.db, c.email)) {
      await ctx.db.update(contacts).set({ status: "suppressed", verifyStatus: "suppressed", updatedAt: now }).where(eq(contacts.id, c.id));
      stats.dropped.suppressed = (stats.dropped.suppressed ?? 0) + 1;
      continue;
    }
    if (!isValidEmailSyntax(c.email)) {
      await drop(c.id, "bad_syntax", "invalid");
      continue;
    }
    if (c.isRoleAddress) {
      if (!caps.allow_role_addresses) {
        await drop(c.id, "role_address_not_allowed");
        continue;
      }
      if (roleBudget <= 0) {
        stats.deferred++; // try again tomorrow
        continue;
      }
    }

    let mx: string[];
    try {
      mx = await deps.mx.resolve(domainOf(c.email));
    } catch {
      stats.deferred++;
      continue;
    }
    if (mx.length === 0) {
      await drop(c.id, "no_mx", "no_mx");
      continue;
    }

    const trusted = vcfg.trust_sources.includes(c.source);
    const pass = async () => {
      await ctx.db
        .update(contacts)
        .set({ status: "verified", verifyStatus: "valid", verifiedAt: now, mailProvider: providerFromMx(mx), updatedAt: now })
        .where(eq(contacts.id, c.id));
      stats.verified++;
      if (c.isRoleAddress) roleBudget--;
    };
    if (trusted && (!deps.verifier || verifierDown)) {
      await pass();
      continue;
    }
    if (!deps.verifier || verifierDown) {
      stats.deferred++; // e.g. CSV imports and referrals wait until ZEROBOUNCE_API_KEY is set
      continue;
    }

    try {
      await assertDailySpendOk(ctx.db, now, caps.daily_spend_cap_usd, vcfg.cost_per_check_usd);
    } catch (err) {
      if (err instanceof SpendCapError) {
        ctx.log.warn("daily spend cap reached; verification paused until tomorrow");
        verifierDown = true;
        if (trusted) await pass();
        else stats.deferred++;
        continue;
      }
      throw err;
    }

    let result;
    try {
      result = await deps.verifier.verify(c.email);
    } catch (err) {
      if (err instanceof VerifierUnavailableError) {
        ctx.log.warn({ err: err.message }, "verifier unavailable (or out of credits); trusted sources pass, others wait");
        verifierDown = true;
        if (trusted) await pass();
        else stats.deferred++;
        continue;
      }
      throw err;
    }
    await recordSpend(ctx.db, "verify", result.costUsd, { companyId: c.companyId, ref: deps.verifier.name, at: now });

    if (result.status === "valid" || (trusted && (result.status === "catch_all" || result.status === "unknown"))) {
      await pass();
    } else if (result.status === "do_not_mail") {
      await suppress(ctx.db, { email: c.email }, `verifier: ${result.subStatus ?? "do_not_mail"}`, deps.verifier.name);
      stats.dropped.do_not_mail = (stats.dropped.do_not_mail ?? 0) + 1;
    } else {
      await drop(c.id, `verifier_${result.status}`, result.status === "catch_all" ? "catch_all" : result.status === "invalid" ? "invalid" : "unknown");
    }
  }
  return stats;
}

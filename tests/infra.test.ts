import { checkDomainDns, recommendedRecords } from "@opengtm/infra";
import { describe, expect, it } from "vitest";

const zone: Record<string, string[][]> = {
  "outreach-mail.example": [["v=spf1 include:spf.protection.outlook.com ~all"], ["google-site-verification=abc"]],
  "_dmarc.outreach-mail.example": [["v=DMARC1; p=none; rua=mailto:dmarc@northwind.example.com"]],
  "selector1._domainkey.outreach-mail.example": [["v=DKIM1; k=rsa; p=MIGf..."]],
};
const resolver = { resolveTxt: async (n: string) => zone[n] ?? Promise.reject(new Error("ENODATA")) };

describe("infra DNS helpers", () => {
  it("passes a correctly configured sending domain", async () => {
    const r = await checkDomainDns("outreach-mail.example", { resolver, mx: async () => [{}] });
    expect(r.spf.ok && r.dmarc.ok && r.dkim.ok && r.mx).toBe(true);
    expect(r.dkim.selector).toBe("selector1");
  });

  it("flags missing records", async () => {
    const r = await checkDomainDns("bare.example", { resolver, mx: async () => [] });
    expect(r.spf).toMatchObject({ ok: false, note: "no SPF record" });
    expect(r.dmarc.ok).toBe(false);
    expect(r.dkim.ok).toBe(false);
  });

  it("recommends SPF + DMARC for the provider", () => {
    expect(recommendedRecords("x.example", "microsoft", "d@x.example")[0]!.content).toContain("spf.protection.outlook.com");
  });
});

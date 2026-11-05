import { promises as dns } from "node:dns";

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export interface DomainDnsReport {
  domain: string;
  spf: { ok: boolean; record: string | null; note?: string };
  dmarc: { ok: boolean; record: string | null; note?: string };
  dkim: { ok: boolean; selector: string | null };
  mx: boolean;
}

async function txt(resolver: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

/** Check the authentication records a cold-email sending domain must have. */
export async function checkDomainDns(
  domain: string,
  opts: { dkimSelectors?: string[]; resolver?: TxtResolver; mx?: (d: string) => Promise<unknown[]> } = {},
): Promise<DomainDnsReport> {
  const resolver = opts.resolver ?? dns;
  const spfRecs = (await txt(resolver, domain)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  const spf = spfRecs.length === 1 ? { ok: /[~-]all\b/.test(spfRecs[0]!), record: spfRecs[0]!, note: /[~-]all\b/.test(spfRecs[0]!) ? undefined : "SPF should end in ~all or -all" } : { ok: false, record: spfRecs[0] ?? null, note: spfRecs.length > 1 ? "multiple SPF records (invalid)" : "no SPF record" };
  const dmarcRec = (await txt(resolver, `_dmarc.${domain}`)).find((r) => r.toLowerCase().startsWith("v=dmarc1")) ?? null;
  const dmarc = dmarcRec ? { ok: true, record: dmarcRec, note: /p=none/i.test(dmarcRec) ? "p=none is fine while warming; move to quarantine later" : undefined } : { ok: false, record: null, note: "no DMARC record (required by Google/Yahoo bulk-sender rules)" };
  let dkim: DomainDnsReport["dkim"] = { ok: false, selector: null };
  for (const sel of opts.dkimSelectors ?? ["google", "selector1", "selector2", "default"]) {
    const recs = await txt(resolver, `${sel}._domainkey.${domain}`);
    if (recs.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) {
      dkim = { ok: true, selector: sel };
      break;
    }
  }
  let mx = false;
  try {
    mx = ((await (opts.mx ?? dns.resolveMx)(domain)) as unknown[]).length > 0;
  } catch {
    mx = false;
  }
  return { domain, spf, dmarc, dkim, mx };
}

/** Records to create for a new sending domain (DKIM comes from the mailbox provider). */
export function recommendedRecords(domain: string, provider: "google" | "microsoft", reportEmail: string) {
  const include = provider === "google" ? "include:_spf.google.com" : "include:spf.protection.outlook.com";
  return [
    { type: "TXT", name: domain, content: `v=spf1 ${include} ~all` },
    { type: "TXT", name: `_dmarc.${domain}`, content: `v=DMARC1; p=none; rua=mailto:${reportEmail}; fo=1` },
  ];
}

/** Minimal Cloudflare DNS helper: create a record if an identical one does not exist. */
export async function cloudflareEnsureRecord(
  token: string,
  zoneName: string,
  rec: { type: string; name: string; content: string },
  fetchImpl: typeof fetch = fetch,
): Promise<"created" | "exists"> {
  const api = "https://api.cloudflare.com/client/v4";
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const zones = (await (await fetchImpl(`${api}/zones?name=${encodeURIComponent(zoneName)}`, { headers: h })).json()) as { result?: { id: string }[] };
  const zoneId = zones.result?.[0]?.id;
  if (!zoneId) throw new Error(`zone ${zoneName} not found in Cloudflare`);
  const existing = (await (await fetchImpl(`${api}/zones/${zoneId}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`, { headers: h })).json()) as { result?: { content: string }[] };
  if (existing.result?.some((r) => r.content.replace(/"/g, "") === rec.content)) return "exists";
  const res = await fetchImpl(`${api}/zones/${zoneId}/dns_records`, { method: "POST", headers: h, body: JSON.stringify({ ...rec, ttl: 1 }) });
  if (!res.ok) throw new Error(`cloudflare ${res.status}: ${await res.text()}`);
  return "created";
}

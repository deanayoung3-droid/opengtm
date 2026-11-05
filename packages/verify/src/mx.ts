import { promises as dns } from "node:dns";

export type MailProvider = "google" | "microsoft" | "other";

export interface MxResolver {
  /** Exchange hostnames ordered by priority; [] when the domain has no MX. */
  resolve(domain: string): Promise<string[]>;
}

export class DnsMxResolver implements MxResolver {
  private cache = new Map<string, string[]>();
  async resolve(domain: string): Promise<string[]> {
    const hit = this.cache.get(domain);
    if (hit) return hit;
    let out: string[];
    try {
      const rows = await dns.resolveMx(domain);
      out = rows.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") out = [];
      else throw err; // transient DNS failure: let the job retry
    }
    this.cache.set(domain, out);
    return out;
  }
}

export class StaticMxResolver implements MxResolver {
  constructor(private map: Record<string, string[]>, private fallback: string[] = ["mx.example.net"]) {}
  async resolve(domain: string): Promise<string[]> {
    return this.map[domain] ?? this.fallback;
  }
}

export function providerFromMx(mx: string[]): MailProvider {
  const first = mx[0] ?? "";
  if (/(^|\.)google\.com$|googlemail\.com$|aspmx\.l\.google\.com$/.test(first)) return "google";
  if (/mail\.protection\.outlook\.com$|outlook\.com$|hotmail\.com$/.test(first)) return "microsoft";
  return "other";
}

export interface HotLeadRecord {
  meetingId: string;
  stage: "hot" | "booked" | "held" | "won" | "lost";
  contact: { name: string; email: string; title: string | null };
  company: { name: string; domain: string; state: string | null };
  whyHot: string | null;
  nextStep: string | null;
  bookedAt: string | null;
}

/** Where hot leads and meetings sync to. The default is our own DB only; implement CRMSink to sync elsewhere. */
export interface CRMSink {
  readonly name: string;
  upsert(record: HotLeadRecord): Promise<void>;
}

export class NoopCrmSink implements CRMSink {
  readonly name = "none";
  async upsert(): Promise<void> {}
}

/** Generic JSON webhook (Zapier/Make/HubSpot workflow, etc). */
export class WebhookCrmSink implements CRMSink {
  readonly name = "webhook";
  constructor(
    private url: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async upsert(record: HotLeadRecord): Promise<void> {
    const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
    if (!res.ok) throw new Error(`crm webhook ${res.status}`);
  }
}

export class MemoryCrmSink implements CRMSink {
  readonly name = "memory";
  records: HotLeadRecord[] = [];
  async upsert(record: HotLeadRecord): Promise<void> {
    this.records.push(record);
  }
}

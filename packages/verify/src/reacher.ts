import { VerifierUnavailableError, type Verifier, type VerifyResult } from "./types";

/**
 * Self-hosted Reacher (check-if-email-exists). Needs outbound port 25, so run
 * it on a VPS, not a home machine, and check its license for commercial use.
 */
export class ReacherVerifier implements Verifier {
  readonly name = "reacher";
  constructor(
    private baseUrl: string,
    private opts: { secret?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  async verify(email: string): Promise<VerifyResult> {
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl.replace(/\/$/, "")}/v0/check_email`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.secret ? { "x-reacher-secret": this.opts.secret } : {}) },
        body: JSON.stringify({ to_email: email }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new VerifierUnavailableError(`reacher network: ${(err as Error).message}`);
    }
    if (!res.ok) throw new VerifierUnavailableError(`reacher ${res.status}`);
    const body = (await res.json()) as { is_reachable?: string; smtp?: { is_catch_all?: boolean } };
    if (body.smtp?.is_catch_all) return { status: "catch_all", costUsd: 0 };
    const map = { safe: "valid", invalid: "invalid", risky: "unknown", unknown: "unknown" } as const;
    return { status: map[(body.is_reachable ?? "unknown") as keyof typeof map] ?? "unknown", subStatus: body.is_reachable, costUsd: 0 };
  }
}

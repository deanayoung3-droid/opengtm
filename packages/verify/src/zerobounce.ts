import { VerifierUnavailableError, type Verifier, type VerifyResult, type VerifyStatus } from "./types";

const MAP: Record<string, VerifyStatus> = {
  valid: "valid",
  invalid: "invalid",
  "catch-all": "catch_all",
  unknown: "unknown",
  spamtrap: "do_not_mail",
  abuse: "do_not_mail",
  do_not_mail: "do_not_mail",
};

/** ZeroBounce single-email validation (https://www.zerobounce.net/docs/email-validation-api-quickstart/). */
export class ZeroBounceVerifier implements Verifier {
  readonly name = "zerobounce";
  constructor(
    private apiKey: string,
    private costPerCheck: number,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(email: string): Promise<VerifyResult> {
    const url = new URL("https://api.zerobounce.net/v2/validate");
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("email", email);
    url.searchParams.set("ip_address", "");
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new VerifierUnavailableError(`zerobounce network: ${(err as Error).message}`);
    }
    if (!res.ok) throw new VerifierUnavailableError(`zerobounce ${res.status}`);
    const body = (await res.json()) as { status?: string; sub_status?: string; error?: string };
    if (body.error) throw new VerifierUnavailableError(`zerobounce: ${body.error}`);
    const status = MAP[(body.status ?? "unknown").toLowerCase()] ?? "unknown";
    // ZeroBounce does not charge for "unknown" results.
    return { status, subStatus: body.sub_status, costUsd: status === "unknown" ? 0 : this.costPerCheck };
  }
}

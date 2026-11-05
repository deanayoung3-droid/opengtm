import type { Verifier, VerifyResult } from "./types";

/**
 * Test verifier. Local parts starting with "invalid" are invalid, "catchall" are
 * catch-all, "trap" are do-not-mail; everything else is valid.
 */
export class MockVerifier implements Verifier {
  readonly name = "mock";
  checked: string[] = [];
  constructor(private costPerCheck = 0.008) {}

  async verify(email: string): Promise<VerifyResult> {
    this.checked.push(email);
    const local = email.split("@")[0] ?? "";
    if (local.startsWith("invalid")) return { status: "invalid", costUsd: this.costPerCheck };
    if (local.startsWith("catchall")) return { status: "catch_all", costUsd: this.costPerCheck };
    if (local.startsWith("trap")) return { status: "do_not_mail", subStatus: "spamtrap", costUsd: this.costPerCheck };
    return { status: "valid", costUsd: this.costPerCheck };
  }
}

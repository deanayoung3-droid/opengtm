export type VerifyStatus = "valid" | "invalid" | "catch_all" | "unknown" | "do_not_mail";

export interface VerifyResult {
  status: VerifyStatus;
  subStatus?: string;
  /** What this check cost, recorded to spend_ledger. */
  costUsd: number;
}

export interface Verifier {
  readonly name: string;
  verify(email: string): Promise<VerifyResult>;
}

export class VerifierUnavailableError extends Error {}

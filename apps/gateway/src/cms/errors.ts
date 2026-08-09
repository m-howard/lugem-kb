/**
 * Thrown when a request is refused by path or branch policy (requirements.md R3, R4).
 *
 * Carries the closed-set reason so the route can answer 403 with it and the audit record can be
 * aggregated by it, exactly as `DocumentPolicyError` already does for corpus reads.
 */
export class CmsPolicyError extends Error {
  public readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CmsPolicyError';
    this.reason = reason;
  }
}

/**
 * Why a request could not be attributed to a person.
 *
 * A closed set rather than a message, because these are not interchangeable to an operator
 * reading the audit log: `missing-credential` is a client that never authenticated,
 * `invalid-signature` is one presenting something forged, and `missing-email` is a correctly
 * signed token from an identity provider that was not configured to release the claim the
 * gateway needs (requirements.md Q4 — several providers omit email by default).
 */
export type IdentityRefusalReason =
  | 'missing-credential'
  | 'malformed-credential'
  | 'invalid-signature'
  | 'expired'
  | 'wrong-audience'
  | 'untrusted-signer'
  | 'missing-subject'
  | 'missing-email';

/** The person a request is attributed to. Every field reaches git history, so every field is required. */
export interface Identity {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export type IdentityResult =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly reason: IdentityRefusalReason; readonly message: string };

/** Which claims carry the email and display name, since providers disagree. */
export interface ClaimNames {
  readonly email: string;
  readonly name: string;
}

export function refuseIdentity(reason: IdentityRefusalReason, message: string): IdentityResult {
  return { ok: false, reason, message };
}

function readString(claims: Record<string, unknown>, claim: string): string | undefined {
  const value = claims[claim];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Turns a set of already-verified JWT claims into an identity, or refuses them.
 *
 * Pure and total: signature checking happens in the verifier, and this decides only whether the
 * verified claims name someone the gateway can attribute a commit to. That split is what lets the
 * whole refusal table be a unit test with no keys and no network.
 *
 * A missing display name falls back to the email rather than refusing. A missing email does
 * refuse: requirements.md R6 puts the author's email in git history for the life of the
 * repository, and a commit attributed to nobody is worse than a request that failed loudly.
 *
 * @param claims - Claims from a token whose signature has already been verified.
 * @param claimNames - Which claim carries the email, and which the display name.
 * @returns The identity, or the reason it could not be established.
 *
 * @example
 * ```ts
 * identityFromClaims({ sub: 'a1b2', email: 'sam@example.com' }, { email: 'email', name: 'name' });
 * // → { ok: true, identity: { subject: 'a1b2', email: 'sam@example.com', name: 'sam@example.com' } }
 * ```
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  claimNames: ClaimNames,
): IdentityResult {
  const subject = readString(claims, 'sub');
  if (subject === undefined) {
    return refuseIdentity('missing-subject', 'The token carries no subject claim.');
  }

  const email = readString(claims, claimNames.email);
  if (email === undefined) {
    return refuseIdentity(
      'missing-email',
      `The token carries no "${claimNames.email}" claim. The identity provider must release it: ` +
        'the gateway records the author in git history and refuses what it cannot attribute.',
    );
  }

  return {
    ok: true,
    identity: { subject, email, name: readString(claims, claimNames.name) ?? email },
  };
}

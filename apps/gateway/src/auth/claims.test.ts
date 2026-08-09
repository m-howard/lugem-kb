import { describe, expect, it } from 'vitest';

import { type ClaimNames, identityFromClaims } from './claims';

const CLAIM_NAMES: ClaimNames = { email: 'email', name: 'name' };

describe('identityFromClaims', () => {
  it('takes the subject, email and display name from the token', () => {
    const result = identityFromClaims(
      { sub: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' },
      CLAIM_NAMES,
    );

    expect(result).toEqual({
      ok: true,
      identity: { subject: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' },
    });
  });

  it('reads whichever claims the provider was configured to use', () => {
    const result = identityFromClaims(
      { sub: 'a1b2', upn: 'sam@example.com', given_name: 'Sam' },
      { email: 'upn', name: 'given_name' },
    );

    expect(result).toMatchObject({ ok: true, identity: { email: 'sam@example.com', name: 'Sam' } });
  });

  // A display name is a convenience; an email is what R6 writes into git history forever. Falling
  // back keeps an author working when their provider is stingy with optional claims.
  it('falls back to the email when no display name is released', () => {
    const result = identityFromClaims({ sub: 'a1b2', email: 'sam@example.com' }, CLAIM_NAMES);

    expect(result).toMatchObject({ ok: true, identity: { name: 'sam@example.com' } });
  });

  // requirements.md Q4: several identity providers omit email from the access token by default.
  // The gateway refuses what it cannot attribute rather than inventing an author.
  describe('refuses', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['no subject', { email: 'sam@example.com' }, 'missing-subject'],
      ['a blank subject', { sub: '   ', email: 'sam@example.com' }, 'missing-subject'],
      ['no email claim', { sub: 'a1b2' }, 'missing-email'],
      ['a blank email claim', { sub: 'a1b2', email: '' }, 'missing-email'],
      ['a non-string email claim', { sub: 'a1b2', email: 42 }, 'missing-email'],
    ];

    it.each(cases)('%s', (_case, claims, reason) => {
      const result = identityFromClaims(claims, CLAIM_NAMES);

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason });
    });

    it('names the claim an operator has to go and configure', () => {
      const result = identityFromClaims({ sub: 'a1b2' }, { email: 'upn', name: 'name' });

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ message: expect.stringContaining('"upn"') as unknown });
    });
  });

  it('trims surrounding whitespace rather than carrying it into git history', () => {
    const result = identityFromClaims(
      { sub: ' a1b2 ', email: ' sam@example.com ', name: ' Sam ' },
      CLAIM_NAMES,
    );

    expect(result).toEqual({
      ok: true,
      identity: { subject: 'a1b2', email: 'sam@example.com', name: 'Sam' },
    });
  });
});

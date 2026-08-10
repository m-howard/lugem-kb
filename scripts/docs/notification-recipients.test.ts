import { describe, expect, it } from 'vitest';

import { parseCodeowners } from './codeowners';
import {
  ownerRecipients,
  type RecipientPolicy,
  submitterRecipients,
} from './notification-recipients';

const RULES = parseCodeowners(`
*               @m-howard
/docs/          @docs-team
/docs/adr/      @platform @docs-team
/docs/scratch/
/apps/gateway/  @platform
`);

const POLICY: RecipientPolicy = {
  rules: RULES,
  directory: {
    '@docs-team': 'docs@example.com',
    '@platform': 'platform@example.com',
    '@m-howard': 'markus@example.com',
  },
  allowedDomains: ['example.com'],
};

describe('ownerRecipients', () => {
  it('routes a corpus page to its owner', () => {
    expect(ownerRecipients(['docs/people/leave.md'], POLICY)).toEqual({
      to: ['docs@example.com'],
      unroutable: [],
    });
  });

  // Last match wins, so an ADR reaches the ADR owners rather than the broader /docs/ entry.
  it('uses the most specific CODEOWNERS entry', () => {
    expect(ownerRecipients(['docs/adr/0006-x.md'], POLICY).to).toEqual([
      'docs@example.com',
      'platform@example.com',
    ]);
  });

  it('sends one message per address when several pages share an owner', () => {
    expect(ownerRecipients(['docs/a.md', 'docs/b.md', 'docs/c.md'], POLICY).to).toEqual([
      'docs@example.com',
    ]);
  });

  // Otherwise every engineering pull request emails a code owner, and people learn to ignore it.
  it('ignores changes outside the corpus', () => {
    expect(ownerRecipients(['apps/gateway/src/app.ts', 'package.json'], POLICY)).toEqual({
      to: [],
      unroutable: [],
    });
  });

  it('routes only the corpus half of a mixed pull request', () => {
    expect(ownerRecipients(['apps/gateway/src/app.ts', 'docs/people/leave.md'], POLICY).to).toEqual(
      ['docs@example.com'],
    );
  });

  it('reports an owner the directory cannot place', () => {
    const policy = { ...POLICY, directory: { '@platform': 'platform@example.com' } };

    expect(ownerRecipients(['docs/people/leave.md'], policy)).toEqual({
      to: [],
      unroutable: ['@docs-team (no entry in the owner directory)'],
    });
  });

  it('refuses an address outside the permitted domains', () => {
    const policy = { ...POLICY, directory: { '@docs-team': 'docs@elsewhere.test' } };

    expect(ownerRecipients(['docs/people/leave.md'], policy)).toEqual({
      to: [],
      unroutable: ['@docs-team → docs@elsewhere.test (outside the permitted domains)'],
    });
  });

  it('still delivers to the owners it can reach', () => {
    const policy = { ...POLICY, directory: { '@platform': 'platform@example.com' } };

    expect(ownerRecipients(['docs/adr/0006-x.md'], policy)).toEqual({
      to: ['platform@example.com'],
      unroutable: ['@docs-team (no entry in the owner directory)'],
    });
  });

  // A CODEOWNERS entry with a pattern and no owner means "this path has no owner".
  it('notifies nobody for a deliberately unowned path', () => {
    expect(ownerRecipients(['docs/scratch/notes.md'], POLICY)).toEqual({
      to: [],
      unroutable: [],
    });
  });

  it('matches domains case-insensitively', () => {
    const policy = { ...POLICY, directory: { '@docs-team': 'Docs@Example.COM' } };

    expect(ownerRecipients(['docs/people/leave.md'], policy).to).toEqual(['Docs@Example.COM']);
  });
});

describe('submitterRecipients', () => {
  it('delivers to an address inside the permitted domains', () => {
    expect(submitterRecipients('sam@example.com', POLICY)).toEqual({
      to: ['sam@example.com'],
      unroutable: [],
    });
  });

  it('refuses one outside them', () => {
    expect(submitterRecipients('attacker@elsewhere.test', POLICY)).toEqual({
      to: [],
      unroutable: ['attacker@elsewhere.test (outside the permitted domains)'],
    });
  });
});

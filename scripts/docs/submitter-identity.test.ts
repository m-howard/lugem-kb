import { describe, expect, it } from 'vitest';

import { parseSubmitter } from './submitter-identity';
import { buildSubmissionBody } from '../../apps/gateway/src/git/attribution';

const CMS_PREFIX = 'cms/';
const IDENTITY = { subject: 'sam', name: 'Sam Okoro', email: 'sam@example.com' };

describe('parseSubmitter', () => {
  // The contract this module actually has is with `buildSubmissionBody`, so the fixture is its
  // real output rather than a copy of the sentence. If either side is reworded, this fails.
  it('reads back what the gateway wrote', () => {
    const body = buildSubmissionBody({ branch: 'cms/leave-policy' }, IDENTITY);

    expect(
      parseSubmitter({ body, headRef: 'cms/leave-policy', cmsBranchPrefix: CMS_PREFIX }),
    ).toEqual({ name: 'Sam Okoro', email: 'sam@example.com' });
  });

  it('reads it back when the author added their own summary', () => {
    const body = buildSubmissionBody(
      { branch: 'cms/leave-policy', summary: 'Rewrote the carry-over section.' },
      IDENTITY,
    );

    expect(
      parseSubmitter({ body, headRef: 'cms/leave-policy', cmsBranchPrefix: CMS_PREFIX })?.email,
    ).toBe('sam@example.com');
  });

  // The whole security property. Only the gateway can create a branch under the CMS prefix, so a
  // body found anywhere else was typed by whoever opened the pull request.
  it('refuses a body on a branch outside the CMS prefix', () => {
    const body = buildSubmissionBody({ branch: 'cms/leave-policy' }, IDENTITY);

    expect(
      parseSubmitter({ body, headRef: 'feature/spoof', cmsBranchPrefix: CMS_PREFIX }),
    ).toBeUndefined();
  });

  it.each([
    ['a mention of an address', 'Ask victim@example.com about this.'],
    ['a near-miss sentence', 'Submitted by **Sam** <sam@example.com> through the CMS.'],
    ['the trailer alone', 'Co-authored-by: Sam Okoro <sam@example.com>'],
    ['an empty body', ''],
  ])('ignores %s', (_case, body) => {
    expect(
      parseSubmitter({ body, headRef: 'cms/leave-policy', cmsBranchPrefix: CMS_PREFIX }),
    ).toBeUndefined();
  });

  it('handles a pull request with no body at all', () => {
    expect(
      parseSubmitter({ body: undefined, headRef: 'cms/x', cmsBranchPrefix: CMS_PREFIX }),
    ).toBeUndefined();
  });

  it('finds the line when it is not the first', () => {
    const body = `Some preamble.\n\nSubmitted by **Ada Lovelace** <ada@example.com> through the documentation CMS.\n`;

    expect(parseSubmitter({ body, headRef: 'cms/x', cmsBranchPrefix: CMS_PREFIX })).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
  });
});

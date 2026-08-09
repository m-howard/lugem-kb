import { describe, expect, it } from 'vitest';

import { buildCommitPayload, buildSubmissionBody, withCoAuthorTrailer } from './attribution';
import { type Identity } from '../auth/claims';

const SAM: Identity = { subject: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' };
const RILEY: Identity = { subject: 'c3d4', email: 'riley@example.com', name: 'Riley Bell' };
const TRAILER = 'Co-authored-by: Sam Okoro <sam@example.com>';

describe('withCoAuthorTrailer', () => {
  it('appends the trailer after a blank line', () => {
    expect(withCoAuthorTrailer('docs: rewrite leave policy', SAM)).toBe(
      `docs: rewrite leave policy\n\n${TRAILER}`,
    );
  });

  // R6: "added exactly once even on retry". A save retried after a network timeout runs this on a
  // message that already carries the trailer.
  it('is idempotent', () => {
    const once = withCoAuthorTrailer('docs: rewrite leave policy', SAM);

    expect(withCoAuthorTrailer(once, SAM)).toBe(once);
    expect(withCoAuthorTrailer(withCoAuthorTrailer(once, SAM), SAM)).toBe(once);
  });

  it('still adds a second author', () => {
    const result = withCoAuthorTrailer(withCoAuthorTrailer('docs: joint edit', SAM), RILEY);

    expect(result).toContain(TRAILER);
    expect(result).toContain('Co-authored-by: Riley Bell <riley@example.com>');
  });

  it('does not mistake a mention of the author for the trailer', () => {
    const result = withCoAuthorTrailer('docs: thank Sam Okoro <sam@example.com> for the review', SAM);

    expect(result.split('\n').filter((line) => line.startsWith('Co-authored-by:'))).toHaveLength(1);
  });

  it('normalises trailing whitespace rather than stacking blank lines', () => {
    expect(withCoAuthorTrailer('docs: rewrite\n\n\n', SAM)).toBe(`docs: rewrite\n\n${TRAILER}`);
  });
});

describe('buildCommitPayload', () => {
  const request = { message: 'docs: rewrite leave policy', tree: 't1', parents: ['c1'] };

  // R6: "Commit author name and email come from the verified token."
  it('takes the author from the verified identity', () => {
    expect(buildCommitPayload(request, SAM).author).toEqual({
      name: 'Sam Okoro',
      email: 'sam@example.com',
    });
  });

  // R6: "Committer remains the app, so the record of what performed the write is accurate."
  // Omitting the field is what leaves the git host filling it in with the App.
  it('sets no committer', () => {
    expect(buildCommitPayload(request, SAM)).not.toHaveProperty('committer');
  });

  // R6: "An author field supplied by the client is discarded and replaced." There is nowhere to
  // supply one — the request type has no author field — so this is structural, not a rule.
  it('has no channel through which a client could name someone else', () => {
    const hostile = { ...request, author: { name: 'Someone Else', email: 'nope@example.com' } };

    expect(buildCommitPayload(hostile, SAM).author).toEqual({
      name: 'Sam Okoro',
      email: 'sam@example.com',
    });
  });

  it('carries the trailer and leaves the tree and parents alone', () => {
    const payload = buildCommitPayload(request, SAM);

    expect(payload.message).toBe(`docs: rewrite leave policy\n\n${TRAILER}`);
    expect(payload.tree).toBe('t1');
    expect(payload.parents).toEqual(['c1']);
  });
});

describe('buildSubmissionBody', () => {
  // R6: "The pull request body names the submitter and their email."
  it('names the submitter and their email', () => {
    const body = buildSubmissionBody({ branch: 'cms/leave-policy' }, SAM);

    expect(body).toContain('Sam Okoro');
    expect(body).toContain('sam@example.com');
    expect(body).toContain('cms/leave-policy');
  });

  it('includes the author summary when they wrote one', () => {
    const body = buildSubmissionBody(
      { branch: 'cms/leave-policy', summary: 'Carry-over is now 5 days.' },
      SAM,
    );

    expect(body).toContain('Carry-over is now 5 days.');
  });

  it.each([[undefined], [''], ['   ']])('omits the summary section for %j', (summary) => {
    const body = buildSubmissionBody({ branch: 'cms/leave-policy', summary }, SAM);

    expect(body).not.toContain('---');
    expect(body.trimEnd()).toBe(body);
  });
});

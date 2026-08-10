import { describe, expect, it } from 'vitest';

import { type DecapContext } from './context';
import { deployPreviewFor } from './preview';
import { type CmsSettings } from '../settings';
import { type Submission } from '../submissions';

const SETTINGS: CmsSettings = {
  repository: 'acme/handbook',
  defaultBranch: 'main',
  branchPrefix: 'cms/',
  pathPrefixes: ['docs/'],
  mediaFolder: 'docs/assets/media/',
  maxUploadBytes: 2_097_152,
};

const ENTRY = { collection: 'docs', slug: 'leave-policy' };

function submission(state: string, number = 42): Submission {
  return {
    number,
    branch: 'cms/docs/leave-policy',
    headRepository: 'acme/handbook',
    base: 'main',
    title: 'docs: update leave-policy',
    state,
    url: `https://github.com/acme/handbook/pull/${String(number)}`,
    mergeable: true,
  };
}

/** Only `submissions.list` and `settings` are read; everything else would be a bug to reach. */
function contextWith(options: {
  readonly submissions: readonly Submission[];
  readonly previewBaseUrl?: string | undefined;
}): DecapContext {
  const listed: string[] = [];

  return {
    settings: SETTINGS,
    submissions: {
      list: (branch?: string) => {
        listed.push(branch ?? '');
        return Promise.resolve(options.submissions);
      },
    },
    previewBaseUrl: options.previewBaseUrl,
    // The adapter reads none of these for a preview; a call would throw rather than pass silently.
    reader: undefined,
    drafts: undefined,
    client: undefined,
    identity: undefined,
    listed,
  } as unknown as DecapContext & { listed: string[] };
}

const BASE_URL = 'https://kb.internal/previews';

describe('deployPreviewFor', () => {
  it('links to the open submission preview', async () => {
    const context = contextWith({ submissions: [submission('open')], previewBaseUrl: BASE_URL });

    await expect(deployPreviewFor(context, ENTRY)).resolves.toEqual({
      url: 'https://kb.internal/previews/pr-42/',
      status: 'SUCCESS',
    });
  });

  it('asks only about this entry draft branch', async () => {
    const context = contextWith({
      submissions: [submission('open')],
      previewBaseUrl: BASE_URL,
    }) as DecapContext & { listed: string[] };

    await deployPreviewFor(context, ENTRY);

    expect(context.listed).toEqual(['cms/docs/leave-policy']);
  });

  it('takes the newest submission when an entry has been through review twice', async () => {
    const context = contextWith({
      submissions: [submission('open', 51), submission('closed', 42)],
      previewBaseUrl: BASE_URL,
    });

    await expect(deployPreviewFor(context, ENTRY)).resolves.toMatchObject({
      url: 'https://kb.internal/previews/pr-51/',
    });
  });

  // `null` is Decap's "no preview for this entry": the card keeps offering to check rather than
  // linking to a build that was never made or has already been deleted.
  it.each([
    ['a draft that has never been submitted', []],
    ['a withdrawn submission', [submission('closed')]],
    ['a merged submission, whose preview the close job deleted', [submission('merged')]],
  ])('answers null for %s', async (_case, submissions) => {
    const context = contextWith({ submissions, previewBaseUrl: BASE_URL });

    await expect(deployPreviewFor(context, ENTRY)).resolves.toBeNull();
  });

  it('answers null when the deployment has no preview surface', async () => {
    const context = contextWith({ submissions: [submission('open')] });

    await expect(deployPreviewFor(context, ENTRY)).resolves.toBeNull();
  });

  // The check comes first so an unconfigured deployment costs no git host call per card.
  it('does not ask the git host when previews are unconfigured', async () => {
    const context = contextWith({ submissions: [submission('open')] }) as DecapContext & {
      listed: string[];
    };

    await deployPreviewFor(context, ENTRY);

    expect(context.listed).toEqual([]);
  });

  it('refuses an entry that cannot name a branch the CMS owns', async () => {
    const context = contextWith({ submissions: [], previewBaseUrl: BASE_URL });

    await expect(deployPreviewFor(context, { collection: 'docs', slug: '' })).rejects.toThrow();
  });
});

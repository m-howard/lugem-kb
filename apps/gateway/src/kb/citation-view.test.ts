import { type S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CitationViewer } from './citation-view';
import { CorpusClient } from './corpus-client';
import { type Citation } from './retrieve';

const BUCKET = 'lugem-corpus';
const PREFIX = 'docs/';
const LOCATION = { bucket: BUCKET, prefix: PREFIX };

function page(reviewed: string): string {
  return `---\ntitle: A page\nowner: platform\nlast_reviewed: ${reviewed}\n---\n\n# A page\n`;
}

const OBJECTS: Record<string, string> = {
  'docs/adr/0005-x.md': page('2026-08-09'),
  'docs/getting-started.md': page('2026-07-01'),
  'docs/untitled.md': '# No frontmatter here\n',
};

function citation(sourceUri: string, score = 0.9): Citation {
  return { sourceUri, text: 'A passage.', score };
}

function viewerOver(send: ReturnType<typeof vi.fn>): CitationViewer {
  const corpus = new CorpusClient({
    s3: { send } as unknown as S3Client,
    bucket: BUCKET,
    prefix: PREFIX,
  });
  return new CitationViewer({ corpus, location: LOCATION });
}

let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  send = vi.fn((command: { input: { Key?: string } }) => {
    const body = OBJECTS[command.input.Key ?? ''];
    if (body === undefined) {
      return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    }
    return Promise.resolve({ Body: { transformToString: () => Promise.resolve(body) } });
  });
});

describe('CitationViewer', () => {
  it('resolves each citation to its page and review date', async () => {
    const views = await viewerOver(send).present([citation(`s3://${BUCKET}/docs/adr/0005-x.md`)]);

    expect(views).toEqual([
      {
        sourceUri: `s3://${BUCKET}/docs/adr/0005-x.md`,
        path: 'adr/0005-x.md',
        url: '/adr/0005-x',
        text: 'A passage.',
        score: 0.9,
        lastReviewed: '2026-08-09',
      },
    ]);
  });

  it('preserves relevance order', async () => {
    const views = await viewerOver(send).present([
      citation(`s3://${BUCKET}/docs/adr/0005-x.md`, 0.9),
      citation(`s3://${BUCKET}/docs/getting-started.md`, 0.5),
    ]);

    expect(views.map((view) => view.url)).toEqual(['/adr/0005-x', '/getting-started']);
  });

  it('reads only the head of each page, not the whole document', async () => {
    await viewerOver(send).present([citation(`s3://${BUCKET}/docs/adr/0005-x.md`)]);

    const command = send.mock.calls[0]?.[0] as { input: { Range?: string } };
    expect(command.input.Range).toMatch(/^bytes=0-\d+$/);
  });

  it('fetches each distinct source once, however many passages came from it', async () => {
    await viewerOver(send).present([
      citation(`s3://${BUCKET}/docs/adr/0005-x.md`, 0.9),
      citation(`s3://${BUCKET}/docs/adr/0005-x.md`, 0.7),
      citation(`s3://${BUCKET}/docs/adr/0005-x.md`, 0.5),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serves a repeated question from cache rather than re-reading S3', async () => {
    const viewer = viewerOver(send);
    await viewer.present([citation(`s3://${BUCKET}/docs/adr/0005-x.md`)]);
    await viewer.present([citation(`s3://${BUCKET}/docs/adr/0005-x.md`)]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  // Failing open is the point: a citation is worth more than its subtitle. None of these cases
  // may throw, because throwing here would fail an answer the reader could otherwise have had.
  describe('fails open', () => {
    it('returns a null date when the page has no frontmatter', async () => {
      const views = await viewerOver(send).present([citation(`s3://${BUCKET}/docs/untitled.md`)]);

      expect(views[0]).toMatchObject({ url: '/untitled', lastReviewed: null });
    });

    it('returns a null date when the page cannot be read at all', async () => {
      const views = await viewerOver(send).present([citation(`s3://${BUCKET}/docs/deleted.md`)]);

      expect(views[0]).toMatchObject({ url: '/deleted', lastReviewed: null });
    });

    it('still answers when S3 is entirely unreachable', async () => {
      const failing = vi.fn(() => Promise.reject(new Error('connection refused')));

      const views = await viewerOver(failing).present([
        citation(`s3://${BUCKET}/docs/adr/0005-x.md`),
      ]);

      expect(views[0]).toMatchObject({ url: '/adr/0005-x', lastReviewed: null });
    });

    it('caches the failure, so one missing page is not re-fetched on every question', async () => {
      const viewer = viewerOver(send);
      await viewer.present([citation(`s3://${BUCKET}/docs/deleted.md`)]);
      await viewer.present([citation(`s3://${BUCKET}/docs/deleted.md`)]);

      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  // A citation whose URI is not ours keeps its passage and loses its link. Dropping it would
  // risk an answer with no citations at all, which R20 forbids.
  it('keeps an unresolvable citation, unlinked and without a date', async () => {
    const views = await viewerOver(send).present([citation('s3://somewhere-else/docs/x.md')]);

    expect(views).toEqual([
      {
        sourceUri: 's3://somewhere-else/docs/x.md',
        path: null,
        url: null,
        text: 'A passage.',
        score: 0.9,
        lastReviewed: null,
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns an empty list for no citations without touching S3', async () => {
    expect(await viewerOver(send).present([])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

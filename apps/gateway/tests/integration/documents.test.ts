import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/build-test-app';

const CORPUS = {
  'docs/index.md': '# Welcome',
  'docs/adr/0001-monorepo.md': '# Monorepo',
  'docs/guides/setup.mdx': '# Setup',
};

describe('GET /v1/documents', () => {
  it('lists documents with paths relative to the corpus prefix', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/v1/documents');
    const body = (await response.json()) as { documents: { path: string }[] };

    expect(response.status).toBe(200);
    expect(body.documents.map((document) => document.path).sort()).toEqual([
      'adr/0001-monorepo.md',
      'guides/setup.mdx',
      'index.md',
    ]);
  });

  it('returns an empty list rather than an error for an empty corpus', async () => {
    const response = await buildTestApp({ objects: {} }).request('/v1/documents');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ documents: [], nextCursor: null });
  });
});

describe('GET /v1/documents/:path', () => {
  it('returns the document body', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/v1/documents/index.md');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ path: 'index.md', body: '# Welcome' });
  });

  it('returns a nested document', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request(
      '/v1/documents/adr/0001-monorepo.md',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ body: '# Monorepo' });
  });

  it('answers 404 for a permitted path with nothing behind it', async () => {
    const response = await buildTestApp({ objects: CORPUS }).request('/v1/documents/absent.md');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  // The 403/404 split is not cosmetic. An operator reviewing the audit log needs "someone asked
  // for something forbidden" to look different from "someone asked for something absent"
  // (requirements.md R9), and a refusal must never be reported as a miss.
  describe('refuses paths that violate key policy with 403', () => {
    it.each([
      ['an encoded backslash', '/v1/documents/adr%5C0001.md'],
      ['a non-permitted extension', '/v1/documents/config.yaml'],
      ['a workflow file inside the tree', '/v1/documents/adr/ci.yml'],
      ['an extensionless path', '/v1/documents/README'],
      ['a markdown lookalike', '/v1/documents/evil.md.sh'],
    ])('%s', async (_case, path) => {
      const response = await buildTestApp({ objects: CORPUS }).request(path);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'forbidden' });
    });

    // Traversal is eliminated before key-policy ever sees it: the WHATWG URL parser collapses
    // dot segments during normalisation, and it decodes `%2e` first, so `..` and `%2E%2E` are
    // both gone by the time Hono routes the request. That makes key-policy's traversal rule
    // defence in depth for callers that are not URLs — the batch resolver and the sync script —
    // rather than dead code. What matters at this layer is the outcome, asserted here: no
    // traversal spelling ever yields corpus content.
    it.each([
      ['a literal parent segment', '/v1/documents/../.github/workflows/ci.md'],
      ['an encoded parent segment', '/v1/documents/%2e%2e/.github/workflows/ci.md'],
      ['a mixed-case encoded segment', '/v1/documents/adr/%2E%2E/%2E%2E/secrets.md'],
    ])('never serves a document for %s', async (_case, path) => {
      const response = await buildTestApp({
        objects: { ...CORPUS, 'secrets.md': 'top secret' },
      }).request(path);

      expect(response.status).not.toBe(200);
      await expect(response.text()).resolves.not.toContain('top secret');
    });

    it('carries the violation reason so refusals can be aggregated', async () => {
      const response = await buildTestApp({ objects: CORPUS }).request('/v1/documents/config.yaml');

      await expect(response.json()).resolves.toMatchObject({ reason: 'extension' });
    });
  });

  // A refusal must be decided before the upstream call, so it can never partially apply (R3).
  // The fake would throw on an unexpected command, so reaching S3 at all would fail this test.
  it('refuses before touching S3', async () => {
    const app = buildTestApp({ objects: CORPUS, corpusUnreachable: true });
    const response = await app.request('/v1/documents/config.yaml');

    expect(response.status).toBe(403);
  });
});

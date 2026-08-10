import { describe, expect, it } from 'vitest';

import { type PreviewPathViolation, resolvePreviewRequest } from './preview-key';

function refusalFor(path: string): PreviewPathViolation | undefined {
  const resolved = resolvePreviewRequest(path);
  return resolved.ok ? undefined : resolved.reason;
}

function keysFor(path: string): readonly string[] {
  const resolved = resolvePreviewRequest(path);
  return resolved.ok ? resolved.keys : [];
}

describe('resolvePreviewRequest', () => {
  it('resolves the preview root to its index', () => {
    const resolved = resolvePreviewRequest('/previews/pr-42/');

    expect(resolved).toEqual({
      ok: true,
      pullNumber: '42',
      keys: ['pr-42/index.html'],
      notFoundKey: 'pr-42/404.html',
    });
  });

  it('resolves the root without a trailing slash the same way', () => {
    expect(keysFor('/previews/pr-42')).toEqual(['pr-42/index.html']);
  });

  // Readers and citations use the two forms interchangeably, so both must reach the same page.
  it.each([
    ['with a trailing slash', '/previews/pr-42/adr/0001/'],
    ['without one', '/previews/pr-42/adr/0001'],
  ])('resolves a route %s to its directory index first', (_case, path) => {
    expect(keysFor(path)).toEqual(['pr-42/adr/0001/index.html', 'pr-42/adr/0001']);
  });

  it('tries an asset as a file first', () => {
    expect(keysFor('/previews/pr-42/assets/css/styles.css')).toEqual([
      'pr-42/assets/css/styles.css',
      'pr-42/assets/css/styles.css/index.html',
    ]);
  });

  it('decodes percent-encoding before resolving', () => {
    expect(keysFor('/previews/pr-7/adr/0005%20draft.html')).toEqual([
      'pr-7/adr/0005 draft.html',
      'pr-7/adr/0005 draft.html/index.html',
    ]);
  });

  it('names the build own 404 page', () => {
    const resolved = resolvePreviewRequest('/previews/pr-7/missing');

    expect(resolved.ok && resolved.notFoundKey).toBe('pr-7/404.html');
  });

  it.each([
    ['a plain traversal', '/previews/pr-42/../secrets'],
    ['an encoded traversal', '/previews/pr-42/%2e%2e/secrets'],
    ['a traversal in the middle', '/previews/pr-42/adr/../../pr-99/index.html'],
    ['a single dot segment', '/previews/pr-42/./index.html'],
  ])('refuses %s', (_case, path) => {
    expect(refusalFor(path)).toBe('traversal');
  });

  it.each([
    ['a missing pull segment', '/previews/', 'pull-number'],
    ['a non-numeric pull segment', '/previews/main/index.html', 'pull-number'],
    ['a pull segment without the prefix', '/previews/42/index.html', 'pull-number'],
    ['pull request zero', '/previews/pr-0/', 'pull-number'],
    ['a leading zero', '/previews/pr-042/', 'pull-number'],
    ['an absurdly long number', '/previews/pr-1234567890123/', 'pull-number'],
    ['a null byte', '/previews/pr-42/index%00.html', 'null-byte'],
    ['a backslash', '/previews/pr-42/adr\\0001.html', 'backslash'],
    ['a double slash', '/previews/pr-42/adr//0001', 'empty-segment'],
    ['malformed encoding', '/previews/pr-42/%E0%A4%A', 'undecodable'],
  ])('refuses %s', (_case, path, reason) => {
    expect(refusalFor(path)).toBe(reason);
  });

  it.each([
    ['the site root', '/'],
    ['an API path', '/v1/ask'],
    ['a lookalike prefix', '/previewsomething/pr-42/'],
  ])('refuses %s as not a preview path', (_case, path) => {
    expect(refusalFor(path)).toBe('not-a-preview-path');
  });

  // Every refusal carries a sentence, because the route puts it in front of a person.
  it('explains every refusal', () => {
    const resolved = resolvePreviewRequest('/previews/main/');

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.message).toContain('/previews/pr-42/');
  });

  it('confines every resolved key to the pull request prefix', () => {
    for (const key of keysFor('/previews/pr-42/adr/0001')) {
      expect(key.startsWith('pr-42/')).toBe(true);
    }
  });
});

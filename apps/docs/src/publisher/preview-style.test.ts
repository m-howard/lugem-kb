import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PREVIEW_STYLE } from './preview-style';

/**
 * The preview pane cannot see the site's stylesheet, so `preview-style.ts` holds a copy of the
 * tokens. These tests are what stops the copy going stale: they read `custom.css` and fail when
 * the two disagree, which is the failure mode a second copy of a palette always has.
 *
 * They also hold the design system's two hard rules — no drop shadows, and the fonts the site
 * actually ships — against a file nobody will think to re-check.
 */

const CUSTOM_CSS = readFileSync(join(import.meta.dirname, '../css/custom.css'), 'utf8');

/** Reads a custom property out of `custom.css`, from its light-mode `:root` block. */
function siteToken(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(CUSTOM_CSS);
  if (match?.[1] === undefined) {
    throw new Error(`custom.css no longer defines ${name}`);
  }
  return match[1].trim();
}

describe('the Decap preview stylesheet', () => {
  it.each([
    ['--ifm-color-primary', 'links'],
    ['--ifm-color-gray-900', 'body ink'],
    ['--ifm-color-gray-700', 'muted text'],
    ['--ifm-color-gray-300', 'code backgrounds'],
    ['--ifm-color-gray-400', 'borders'],
    ['--ifm-color-gray-100', 'panels'],
  ])("uses the site's %s for %s", (token) => {
    expect(PREVIEW_STYLE).toContain(siteToken(token));
  });

  it.each([
    ['--lugem-prose-font-size', 'prose'],
    // h1, not "the first heading": in this corpus a page's `# heading` is its title, and the
    // preview gives every h1 that step. See the note in preview-style.ts.
    ['--lugem-title-font-size', 'h1'],
    ['--ifm-h2-font-size', 'h2'],
    ['--ifm-h3-font-size', 'h3'],
    ['--ifm-h4-font-size', 'h4'],
  ])('sets %s at the size the site renders %s', (token) => {
    expect(PREVIEW_STYLE).toContain(`font-size: ${siteToken(token)};`);
  });

  // The whole point of the pane. Decap's default preview is unstyled, so an author would otherwise
  // be writing in whatever the browser does with bare markup.
  it('declares both faces the site ships', () => {
    expect(PREVIEW_STYLE).toContain("font-family: 'DM Sans'");
    expect(PREVIEW_STYLE).toContain("font-family: 'JetBrains Mono'");
  });

  // Same origin as the editor, and the same files the site serves — not a Google Fonts URL.
  it('loads its fonts from this origin', () => {
    const sources = [...PREVIEW_STYLE.matchAll(/src:\s*url\('([^']+)'\)/g)].map(([, url]) => url);

    expect(sources).toEqual(['/fonts/dm-sans-latin.woff2', '/fonts/jetbrains-mono-latin.woff2']);
  });

  it('casts no shadows, which the design system forbids', () => {
    expect(PREVIEW_STYLE).not.toMatch(/box-shadow|text-shadow|drop-shadow/);
  });

  // An oversized upload pushing the prose off the pane defeats the preview exactly when someone is
  // checking an image. See ADR 0021.
  it('constrains images to the pane', () => {
    expect(PREVIEW_STYLE).toContain('max-width: 100%');
  });
});

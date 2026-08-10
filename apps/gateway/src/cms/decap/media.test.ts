import { describe, expect, it } from 'vitest';

import { resolveAssets } from './media';
import { CmsPolicyError, MediaTooLargeError } from '../errors';
import { type CmsSettings } from '../settings';

const MEDIA_FOLDER = 'docs/assets/media/';

const SETTINGS: CmsSettings = {
  repository: 'acme/handbook',
  defaultBranch: 'main',
  branchPrefix: 'cms/',
  pathPrefixes: ['docs/'],
  mediaFolder: MEDIA_FOLDER,
  maxUploadBytes: 1024,
};

/** A one-pixel PNG, base64 encoded. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAd8s6BwAAAABJRU5ErkJggg==';

function asset(path: string, content = PNG_BASE64) {
  return { path, content, encoding: 'base64' as const };
}

describe('resolveAssets', () => {
  it('turns an image into a draft file, bytes untouched', () => {
    expect(resolveAssets([asset(`${MEDIA_FOLDER}org-chart.png`)], SETTINGS)).toEqual([
      { path: `${MEDIA_FOLDER}org-chart.png`, content: PNG_BASE64, encoding: 'base64' },
    ]);
  });

  it('accepts several images at once', () => {
    const assets = [asset(`${MEDIA_FOLDER}a.png`), asset(`${MEDIA_FOLDER}b.png`)];

    expect(resolveAssets(assets, SETTINGS)).toHaveLength(2);
  });

  it('accepts a save with no images', () => {
    expect(resolveAssets([], SETTINGS)).toEqual([]);
  });

  it('reports an oversized image as too large rather than as a refusal', () => {
    const big = Buffer.alloc(SETTINGS.maxUploadBytes + 1, 0);
    const content = Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), big]).toString('base64');

    expect(() => resolveAssets([asset(`${MEDIA_FOLDER}big.png`, content)], SETTINGS)).toThrow(
      MediaTooLargeError,
    );
  });

  it('accepts an image at exactly the limit', () => {
    const png = Buffer.from(PNG_BASE64, 'base64');
    const padded = Buffer.concat([png, Buffer.alloc(SETTINGS.maxUploadBytes - png.length, 0)]);

    expect(() =>
      resolveAssets([asset(`${MEDIA_FOLDER}exact.png`, padded.toString('base64'))], SETTINGS),
    ).not.toThrow();
  });

  describe('refuses', () => {
    interface RefusalCase {
      readonly name: string;
      readonly path: string;
      readonly content: string;
      readonly reason: string;
    }

    const cases: readonly RefusalCase[] = [
      {
        name: 'markdown',
        path: `${MEDIA_FOLDER}notes.md`,
        content: Buffer.from('# notes', 'utf8').toString('base64'),
        reason: 'media-extension',
      },
      {
        name: 'an svg',
        path: `${MEDIA_FOLDER}diagram.svg`,
        content: PNG_BASE64,
        reason: 'media-extension',
      },
      {
        name: 'an image outside the folder',
        path: 'docs/guides/inline.png',
        content: PNG_BASE64,
        reason: 'media-outside-folder',
      },
      {
        name: 'traversal',
        path: `${MEDIA_FOLDER}../../ci.png`,
        content: PNG_BASE64,
        reason: 'traversal',
      },
      {
        name: 'html wearing a png name',
        path: `${MEDIA_FOLDER}x.png`,
        content: Buffer.from('<!doctype html>', 'utf8').toString('base64'),
        reason: 'media-content-mismatch',
      },
      // `Buffer.from` discards what it cannot read and returns a short buffer rather than failing,
      // so without the round-trip comparison this would be written as a truncated file.
      {
        name: 'a payload that is not base64',
        path: `${MEDIA_FOLDER}x.png`,
        content: 'not base64 %%%',
        reason: 'media-content-mismatch',
      },
    ];

    it.each(cases)('$name', ({ path, content, reason }) => {
      try {
        resolveAssets([asset(path, content)], SETTINGS);
        expect.unreachable('resolveAssets should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CmsPolicyError);
        expect((error as CmsPolicyError).reason).toBe(reason);
      }
    });
  });

  // R3's rule applied to media: a save that applied its good half would leave a page referring to
  // an image that is not there, reviewed by nobody.
  it('refuses the whole set when one image is bad, whichever position it is in', () => {
    const good = asset(`${MEDIA_FOLDER}good.png`);
    const bad = asset(`${MEDIA_FOLDER}bad.exe`);

    expect(() => resolveAssets([good, bad], SETTINGS)).toThrow(CmsPolicyError);
    expect(() => resolveAssets([bad, good], SETTINGS)).toThrow(CmsPolicyError);
  });
});

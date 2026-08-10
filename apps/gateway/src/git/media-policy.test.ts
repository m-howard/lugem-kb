import { describe, expect, it } from 'vitest';

import {
  checkMediaSignature,
  checkMediaSize,
  formatBytes,
  MEDIA_EXTENSIONS,
  mediaFileName,
  resolveMediaPath,
} from './media-policy';

const FOLDER = 'docs/assets/media/';
const options = { folder: FOLDER };

/** A byte sequence with the given leading bytes, long enough for every signature check. */
function bytes(...leading: number[]): Uint8Array {
  const buffer = new Uint8Array(16);
  buffer.set(leading);
  return buffer;
}

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
const HTML = bytes(0x3c, 0x21, 0x64, 0x6f, 0x63);

describe('resolveMediaPath', () => {
  describe('accepts', () => {
    const cases: readonly [string, string][] = [
      ['a png in the folder', `${FOLDER}org-chart.png`],
      ['a jpeg', `${FOLDER}team.jpeg`],
      ['a jpg', `${FOLDER}team.jpg`],
      ['a gif', `${FOLDER}flow.gif`],
      ['a webp', `${FOLDER}screenshot.webp`],
      ['an extension in a different case', `${FOLDER}Org-Chart.PNG`],
      ['a file in a sub-folder of the media folder', `${FOLDER}hr/onboarding.png`],
    ];

    it.each(cases)('%s', (_case, path) => {
      expect(resolveMediaPath(path, options)).toEqual({ ok: true, path });
    });
  });

  describe('refuses', () => {
    const cases: readonly [string, string, string][] = [
      ['markdown', `${FOLDER}notes.md`, 'media-extension'],
      ['an svg, which could carry a script', `${FOLDER}diagram.svg`, 'media-extension'],
      ['an avif the site could not render', `${FOLDER}photo.avif`, 'media-extension'],
      ['an executable', `${FOLDER}payload.exe`, 'media-extension'],
      ['no extension at all', `${FOLDER}payload`, 'media-extension'],
      ['a png outside the media folder', 'docs/guides/org-chart.png', 'media-outside-folder'],
      ['a png at the repository root', 'org-chart.png', 'media-outside-folder'],
      // The folder is a directory boundary, exactly as a corpus prefix is.
      [
        'a sibling folder sharing a name prefix',
        'docs/assets/media-old/x.png',
        'media-outside-folder',
      ],
      ['traversal out of the folder', `${FOLDER}../../../.github/x.png`, 'traversal'],
      ['a backslash', `${FOLDER}a\\b.png`, 'backslash'],
      ['an absolute path', `/${FOLDER}x.png`, 'absolute-path'],
      ['an empty segment', `${FOLDER}a//b.png`, 'empty-segment'],
      ['an empty path', '', 'empty-path'],
    ];

    it.each(cases)('%s', (_case, path, reason) => {
      const resolved = resolveMediaPath(path, options);

      expect(resolved.ok).toBe(false);
      expect(resolved.ok ? undefined : resolved.reason).toBe(reason);
    });
  });

  it('refuses everything when no folder is configured, rather than accepting everything', () => {
    const resolved = resolveMediaPath('anywhere/at/all.png', { folder: '' });

    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? '' : resolved.message).toContain('no folder configured');
  });

  it('accepts a folder configured without a trailing slash', () => {
    expect(resolveMediaPath(`${FOLDER}x.png`, { folder: 'docs/assets/media' }).ok).toBe(true);
  });

  it('names every permitted extension when it refuses one', () => {
    const resolved = resolveMediaPath(`${FOLDER}x.bmp`, options);

    for (const extension of MEDIA_EXTENSIONS) {
      expect(resolved.ok ? '' : resolved.message).toContain(extension);
    }
  });
});

describe('checkMediaSize', () => {
  const path = `${FOLDER}org-chart.png`;

  it('accepts an upload at exactly the limit', () => {
    expect(checkMediaSize(2048, { maxBytes: 2048, path })).toBeUndefined();
  });

  it('refuses one byte over', () => {
    expect(checkMediaSize(2049, { maxBytes: 2048, path })).toBeDefined();
  });

  it('names both sizes and the file, so the author knows what to change', () => {
    const message = checkMediaSize(4_200_000, { maxBytes: 2_097_152, path });

    expect(message).toContain('org-chart.png');
    expect(message).toContain('4.2 MB');
    expect(message).toContain('2.1 MB');
  });
});

describe('checkMediaSignature', () => {
  describe('accepts bytes matching the name', () => {
    const cases: readonly [string, Uint8Array][] = [
      ['org-chart.png', PNG],
      ['team.jpg', JPEG],
      ['team.jpeg', JPEG],
      ['flow.gif', GIF],
      ['screenshot.webp', WEBP],
    ];

    it.each(cases)('%s', (name, content) => {
      expect(checkMediaSignature(content, `${FOLDER}${name}`)).toBeUndefined();
    });
  });

  describe('refuses bytes that are something else', () => {
    const cases: readonly [string, string, Uint8Array][] = [
      ['html named as a png', 'org-chart.png', HTML],
      ['a jpeg named as a png', 'org-chart.png', JPEG],
      ['a png named as a jpeg', 'team.jpg', PNG],
      ['a truncated png', 'org-chart.png', bytes(0x89, 0x50)],
      ['a riff container that is not webp', 'x.webp', bytes(0x52, 0x49, 0x46, 0x46)],
    ];

    it.each(cases)('%s', (_case, name, content) => {
      const refusal = checkMediaSignature(content, `${FOLDER}${name}`);

      expect(refusal?.reason).toBe('media-content-mismatch');
      expect(refusal?.message).toContain(name);
    });
  });

  it('has no opinion about an extension it knows no signature for', () => {
    expect(checkMediaSignature(HTML, `${FOLDER}x.bmp`)).toBeUndefined();
  });
});

describe('formatBytes', () => {
  const cases: readonly [number, string][] = [
    [0, '0 bytes'],
    [512, '512 bytes'],
    [2048, '2 kB'],
    [2_097_152, '2.1 MB'],
    [4_200_000, '4.2 MB'],
  ];

  it.each(cases)('%i → %s', (value, expected) => {
    expect(formatBytes(value)).toBe(expected);
  });
});

describe('mediaFileName', () => {
  it('is the last segment', () => {
    expect(mediaFileName(`${FOLDER}hr/onboarding.png`)).toBe('onboarding.png');
  });

  it('is the whole path when there is no folder', () => {
    expect(mediaFileName('onboarding.png')).toBe('onboarding.png');
  });
});

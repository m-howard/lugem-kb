import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `custom.css` against the design system it claims to implement.
 *
 * `.claude/skills/design-system/` is a vendored export, re-synced wholesale from Claude Design —
 * `.prettierignore` says as much. A re-sync that moves a token would leave this site quietly
 * implementing the previous version of the brand, and nothing else in the repository would notice:
 * the stylesheet is valid CSS either way and every test still passes.
 *
 * So these read both files and compare. They assert the *values* are present, not where they are
 * used — mapping indigo onto `--ifm-color-primary` is a decision this repository gets to make and
 * change, but shipping a colour the system no longer contains is a mistake either way.
 *
 * A failure here means one of two things, and the diff will say which: the export moved and
 * `custom.css` should follow, or someone hand-edited a hex that belongs to the system.
 */

const REPO_ROOT = join(import.meta.dirname, '../../../..');

/**
 * Declarations only.
 *
 * `custom.css` explains itself at length, and those comments name the things they are explaining —
 * Aeonik, `fonts.googleapis.com`, the shadows that were removed. Asserting against the raw file
 * would be asserting against prose: every rule below would pass or fail on how a comment is worded.
 */
function declarations(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const SYSTEM_CSS = declarations(
  join(REPO_ROOT, '.claude/skills/design-system/colors_and_type.css'),
);
const CUSTOM_CSS = declarations(join(import.meta.dirname, 'custom.css'));

/** Reads a token out of the vendored export. */
function systemToken(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(SYSTEM_CSS);
  if (match?.[1] === undefined) {
    throw new Error(`the design system export no longer defines ${name}`);
  }
  return match[1].trim();
}

/** Every token this site consumes, and the role it was mapped to. */
const CONSUMED = [
  ['--c-indigo', 'primary'],
  ['--c-indigo-60', 'the dark theme primary'],
  ['--c-indigo-40', 'the dark theme code keyword'],
  ['--c-slate', 'the dark page and body ink'],
  ['--c-mist', 'code surfaces and the grey ramp'],
  ['--c-emerald', 'success'],
  ['--c-amber', 'warning'],
  ['--c-coral', 'danger'],
  ['--c-violet', 'info'],
  ['--c-bg', 'the light page'],
  ['--c-bg-2', 'the raised light surface'],
  ['--c-ink', 'body ink'],
  ['--c-ink-2', 'secondary text'],
  ['--c-ink-3', 'muted text'],
  ['--c-border', 'the default border'],
] as const;

describe('custom.css against the vendored design system', () => {
  it.each(CONSUMED)("still ships the export's %s, mapped to %s", (token) => {
    expect(CUSTOM_CSS).toContain(systemToken(token));
  });

  it('uses the system font stack, with DM Sans standing in for the unlicensed Aeonik', () => {
    expect(systemToken('--f-sans')).toContain("'DM Sans'");
    expect(CUSTOM_CSS).toContain("'DM Sans'");
    expect(CUSTOM_CSS).not.toContain('Aeonik');
  });

  it('uses the system monospace family', () => {
    expect(systemToken('--f-mono')).toContain("'JetBrains Mono'");
    expect(CUSTOM_CSS).toContain("'JetBrains Mono'");
  });

  // The rule the system states first, and the one a later edit is most likely to undo.
  it('casts no shadows', () => {
    expect(CUSTOM_CSS).not.toMatch(/box-shadow:\s*(?!none)/);
    expect(CUSTOM_CSS).not.toMatch(/text-shadow|drop-shadow/);
  });

  // Not stylistic. The export's own comment says white fails on amber, and measured it is 2.15:1.
  it('never puts white on a semantic fill', () => {
    for (const semantic of ['warning', 'success', 'danger']) {
      const pair = new RegExp(`--ifm-color-${semantic}-contrast-foreground:\\s*([^;]+);`, 'g');
      for (const [, value] of CUSTOM_CSS.matchAll(pair)) {
        expect(value.trim().toLowerCase()).not.toMatch(/^(#fff|#ffffff|white)$/);
      }
    }
  });

  // The faces are served from static/fonts/. The export's `@import` is the one thing in it this
  // site deliberately does not copy, and a re-sync is exactly when it could creep back in.
  it("does not inherit the export's Google Fonts @import", () => {
    expect(SYSTEM_CSS).toContain('fonts.googleapis.com');
    expect(CUSTOM_CSS).not.toContain('fonts.googleapis.com');
    expect(CUSTOM_CSS).not.toContain('fonts.gstatic.com');
  });
});

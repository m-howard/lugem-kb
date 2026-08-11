import type { PrismTheme } from 'prism-react-renderer';

/**
 * Syntax highlighting in the design system's palette.
 *
 * One theme, not two. `prism-react-renderer` applies these as inline styles, and inline styles
 * resolve `var()` against the element — so every colour here is a custom property that
 * `src/css/custom.css` redefines under `html[data-theme='dark']`, and the light and dark palettes
 * switch in CSS with no second object to keep in step. `docusaurus.config.ts` passes it as both
 * `theme` and `darkTheme` for that reason.
 *
 * It also means colour stays in one file. Every hex in this project lives in `custom.css`, which is
 * where the comment at the top of that file says contrast decisions belong.
 *
 * Six colours, because six is what the system's families give at readable contrast on a code
 * background — the token names say which family, and `custom.css` records the measured ratio.
 */

/** Prism's token types, grouped by the system colour each one takes. */
const TOKEN_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'var(--lugem-code-comment)': ['comment', 'prolog', 'doctype', 'cdata'],
  'var(--lugem-code-plain)': ['punctuation', 'operator', 'entity', 'url'],
  'var(--lugem-code-keyword)': ['keyword', 'selector', 'at-rule', 'important', 'tag', 'rule'],
  'var(--lugem-code-string)': ['string', 'char', 'attr-value', 'inserted', 'builtin', 'regex'],
  'var(--lugem-code-number)': ['number', 'boolean', 'constant', 'symbol', 'variable', 'property'],
  'var(--lugem-code-function)': ['function', 'class-name', 'attr-name', 'deleted', 'namespace'],
};

export const PRISM_THEME: PrismTheme = {
  plain: {
    color: 'var(--lugem-code-plain)',
    // Infima already paints the block; repeating it here would put a second opinion on the same
    // surface, and this is the one Docusaurus lets `custom.css` own.
    backgroundColor: 'var(--ifm-pre-background)',
  },
  styles: Object.entries(TOKEN_GROUPS).map(([color, types]) => ({
    types: [...types],
    style: { color },
  })),
};

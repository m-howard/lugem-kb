/**
 * The stylesheet Decap renders a draft inside.
 *
 * Decap's preview pane is unstyled by default, so without this an author writes in Decap's chrome
 * and finds out what the page looks like after it is published. That is the wrong order: the
 * preview is the surface an author spends the whole session looking at, and the closer it is to
 * the rendered page the fewer surprises survive to review.
 *
 * It is a string rather than a file because the preview runs in an iframe with its own document.
 * `CMS.registerPreviewStyle` takes either a URL or, with `{ raw: true }`, the CSS itself; raw wins
 * here because it travels inside the bundle `scripts/build/build-publisher.ts` already produces
 * and cannot 404 the way a second request could.
 *
 * The values are deliberate copies of `apps/docs/src/css/custom.css` — the iframe cannot see the
 * site's stylesheet, and inlining a copy is the only way in. `preview-style.test.ts` reads both
 * files and fails when they disagree, which is the part that keeps a copy honest.
 *
 * Light only, on purpose. Decap's own chrome is light and cannot be themed (see ADR 0015 on why
 * this repository does not fight the package), so a dark preview pane would sit in a white editor
 * looking like a bug rather than a setting.
 */

/** Every token the preview uses, named as the design system names them. */
const TOKENS = {
  surface: '#ffffff',
  ink: '#0f172a', // slate-900 · --c-ink
  inkMuted: '#475569', // slate-600 · --c-ink-2
  primary: '#4f46e5', // --c-indigo
  mist: '#e2e8f0', // slate-200 · --c-mist · code and dividers
  border: '#cbd5e1', // slate-300 · --c-border
  panel: '#f8fafc', // slate-50 · --c-bg · blockquote and table stripes
} as const;

/**
 * The site's rendered type scale.
 *
 * Sized in rem against a 16px root, as `custom.css` is: the system's `--text-base` is the *prose*
 * size, not the root, and the two are set separately there so the layout keeps its 16px rem. Both
 * documents therefore agree on 0.9375rem meaning 15px.
 *
 * `h1` takes the *title* step, `--text-3xl`, not the in-body h1 size. Docusaurus gives the first
 * heading of a page that step, and in this corpus a page's `# heading` is that heading — so 48px
 * is what an author will actually see published. It is applied to every h1 rather than the first,
 * because Decap renders the `title` field's own preview as an h1 above the body and scoping it to
 * `:first-of-type` lands the title size on that instead of on the page's heading.
 */
const SCALE = {
  body: '0.9375rem',
  title: '3rem',
  h2: '1.6875rem',
  h3: '1.3125rem',
  h4: '1.0625rem',
  h5: '0.9375rem',
  h6: '0.8125rem',
} as const;

export const PREVIEW_STYLE = `
/* Served from the docs site's static/fonts/, same origin as the editor. */
@font-face {
  font-family: 'DM Sans';
  src: url('/fonts/dm-sans-latin.woff2') format('woff2');
  font-weight: 300 700;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'JetBrains Mono';
  src: url('/fonts/jetbrains-mono-latin.woff2') format('woff2');
  font-weight: 400 700;
  font-style: normal;
  font-display: swap;
}

body {
  margin: 0;
  padding: 2rem 2.5rem 4rem;
  background: ${TOKENS.surface};
  color: ${TOKENS.ink};
  font-family: 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: ${SCALE.body}; /* --lugem-prose-font-size */
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

/* The measure the published page settles at. Decap's pane is resizable and prose set to the full
   width of a wide one is not a preview of anything. */
body > * {
  max-width: 46rem;
}

h1, h2, h3, h4, h5, h6 {
  margin: 2rem 0 1rem;
  line-height: 1.25;
}

h1 { font-size: ${SCALE.title}; font-weight: 700; letter-spacing: -0.03em; }
h2 { font-size: ${SCALE.h2}; font-weight: 600; letter-spacing: -0.02em; }
h3 { font-size: ${SCALE.h3}; font-weight: 500; letter-spacing: -0.02em; }
h4 { font-size: ${SCALE.h4}; font-weight: 500; }
h5 { font-size: ${SCALE.h5}; font-weight: 500; }
h6 { font-size: ${SCALE.h6}; font-weight: 500; }

/* First heading of a draft sits at the top of the pane, not a screen below it. */
body > :first-child {
  margin-top: 0;
}

p, ul, ol {
  margin: 0 0 1.25rem;
}

ul, ol {
  padding-left: 2rem;
}

li {
  margin-bottom: 0.25rem;
}

a {
  color: ${TOKENS.primary};
  text-decoration: underline;
}

strong {
  font-weight: 600;
}

code, pre, kbd, samp {
  font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}

code {
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  background: ${TOKENS.mist};
  font-size: 95%;
}

pre {
  overflow-x: auto;
  margin: 0 0 1.25rem;
  padding: 1rem;
  border-radius: 4px;
  background: ${TOKENS.mist};
  font-size: 95%;
  line-height: 1.5;
}

/* Already inside a styled block; a second background and padding reads as a box in a box. */
pre code {
  padding: 0;
  background: none;
  font-size: 100%;
}

blockquote {
  margin: 0 0 1.25rem;
  padding: 0.5rem 1rem;
  border-left: 3px solid ${TOKENS.border};
  background: ${TOKENS.panel};
  color: ${TOKENS.inkMuted};
}

hr {
  height: 1px;
  margin: 2rem 0;
  border: 0;
  background: ${TOKENS.border};
}

table {
  display: block;
  overflow-x: auto;
  margin: 0 0 1.25rem;
  border-collapse: collapse;
}

th, td {
  padding: 0.75rem;
  border: 1px solid ${TOKENS.mist};
}

th {
  font-weight: 600;
  text-align: left;
}

tbody tr:nth-child(2n) {
  background: ${TOKENS.panel};
}

/*
 * An upload is full-size until the gateway has it (ADR 0021), and a 4000px screenshot would push
 * the prose off the pane and make the preview useless exactly when someone is checking an image.
 */
img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}
`;

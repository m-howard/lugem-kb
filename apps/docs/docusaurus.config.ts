import { gatewayProxyRules } from './src/dev/gateway-proxy';
import { PRISM_THEME } from './src/prism/prism-theme';

import type * as Preset from '@docusaurus/preset-classic';
import type { Config, Plugin } from '@docusaurus/types';

/** Docusaurus exports the hook but not its return type, so it is taken from the hook. */
type WebpackTweaks = ReturnType<NonNullable<Plugin['configureWebpack']>>;

const ORGANIZATION = 'm-howard';
const PROJECT = 'lugem-kb';
const EDIT_BASE = `https://github.com/${ORGANIZATION}/${PROJECT}/tree/main/`;

/**
 * The content root is the repo-root `docs/` tree, not a copy inside this workspace.
 *
 * One tree is the corpus: it is what this site publishes, what `scripts/docs/sync-corpus.ts`
 * uploads to S3, and what Bedrock ingests. A second copy would let the site and the knowledge
 * base drift, and a reader would have no way to tell which one was stale.
 */
const CONTENT_ROOT = '../../docs';

/**
 * Where this build will be served from.
 *
 * `/` for the published site, and `/previews/pr-42/` for a pull request preview — the workflow in
 * `.github/workflows/preview.yml` sets it per build (requirements.md R12). Docusaurus bakes the
 * base path into every asset URL at build time, so a preview built with the default would ask for
 * its stylesheets at the site root and render unstyled.
 */
const BASE_URL = process.env.DOCUSAURUS_BASE_URL ?? '/';

/**
 * Where images uploaded through the CMS are published from (requirements.md R15).
 *
 * `docs/assets/` is the corpus's non-prose subtree, and Docusaurus copies a static directory's
 * *contents* to the site root — so `docs/assets/media/org-chart.png` is served at
 * `/media/org-chart.png`, which is the path the gateway tells the editor to write into the markdown.
 * That indirection is the reason uploads sit one level inside: pointing this at the media folder
 * itself would publish images at the site root, and pointing it at `../../docs` would copy every
 * page's markdown source into the build alongside its rendered page.
 *
 * `CMS_MEDIA_FOLDER` on the gateway must agree with this. Both default to the same place, and
 * `/v1/cms/config` derives the public path from the folder name so the two cannot drift silently.
 * See [ADR 0021](../../docs/adr/0021-images-travel-with-the-draft.md).
 */
const STATIC_DIRECTORIES = ['static', '../../docs/assets'];

/**
 * The editor, at the origin root — not `BASE_URL + publisher/`.
 *
 * `static/publisher/` is copied into every build, previews included, but there is only one editor
 * per deployment and it lives at the site root: `src/publisher/main.ts` registers
 * `origin + /publisher/` as its OIDC redirect URI, and that exact string is what the identity
 * provider has on file. A preview's copy would sign an author in and land them on the root page
 * anyway, one confusing hop later. `autoAddBaseUrl: false` on the navbar item keeps the link
 * honest about where the editor actually is.
 */
const PUBLISHER_PATH = '/publisher/';

/**
 * Puts the gateway behind the dev server, so `docusaurus start` is one working origin.
 *
 * Docusaurus has no configuration field for this, but it merges a `devServer` block contributed by
 * a plugin over its own — which is the documented extension point and all this plugin is.
 *
 * Development only, and guarded rather than assumed: `configureWebpack` also runs for `build`, and
 * a `devServer` key in a production bundle is dead weight at best.
 */
function gatewayDevProxy(): Plugin {
  return {
    name: 'gateway-dev-proxy',
    configureWebpack: (): WebpackTweaks => {
      if (process.env.NODE_ENV === 'production') {
        return {};
      }
      // Asserted, once. `devServer` is webpack-dev-server's augmentation of webpack's own
      // `Configuration`, and that package is Docusaurus's dependency rather than this workspace's
      // — so the key is read at runtime and invisible to `tsc` here. `gatewayProxyRules` is the
      // typed half, and it is the half that can be wrong.
      return {
        devServer: { proxy: gatewayProxyRules(process.env.GATEWAY_ORIGIN) },
      } as WebpackTweaks;
    },
  };
}

const config: Config = {
  title: 'Lugem Knowledge Base',
  tagline: 'Documentation that publishes itself and answers questions',
  favicon: 'img/favicon.svg',

  url: 'https://lugem-kb.example.com',
  baseUrl: BASE_URL,
  staticDirectories: STATIC_DIRECTORIES,

  organizationName: ORGANIZATION,
  projectName: PROJECT,

  // A broken link in the corpus becomes a broken citation once the page is indexed, so the
  // build fails on one rather than shipping it.
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  markdown: {
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },
  themes: ['@docusaurus/theme-mermaid'],
  plugins: [gatewayDevProxy],

  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      {
        docs: {
          path: CONTENT_ROOT,
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: EDIT_BASE,
          showLastUpdateTime: true,
          // Keep numeric filename prefixes in the URL. Docusaurus strips them by default,
          // treating `0007-` as ordering metadata — but an ADR is cited *by its number*, and
          // these URLs are what retrieval citations resolve to. A one-to-one mapping from
          // filename to route is worth more here than prefix-based ordering; pages needing a
          // specific order use `sidebar_position`.
          numberPrefixParser: false,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Lugem KB',
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
        { to: '/ask', label: 'Ask', position: 'left' },
        {
          // `href` with a `target`, rather than `to`: the editor is a standalone page in
          // `static/`, not a route this site's router knows about. A `to` would hand the click to
          // react-router, which would answer it with the 404 page — and `onBrokenLinks: 'throw'`
          // would fail the build first. A target other than `_self` is what makes Docusaurus's
          // `Link` emit a plain anchor and do a real navigation; `_blank` is also the kinder of
          // the two here, since the editor replaces the page with an application and a reader who
          // wandered in still has their page to go back to.
          href: PUBLISHER_PATH,
          autoAddBaseUrl: false,
          target: '_blank',
          rel: 'noopener',
          label: 'Publisher',
          position: 'right',
        },
        {
          href: `https://github.com/${ORGANIZATION}/${PROJECT}`,
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      copyright: `MIT licensed. Built with Docusaurus.`,
    },
    // The same theme in both slots on purpose: its colours are CSS variables, so `custom.css`
    // swaps the palette per colour mode and there is no second object to drift. See
    // `src/prism/prism-theme.ts`.
    prism: {
      theme: PRISM_THEME,
      darkTheme: PRISM_THEME,
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

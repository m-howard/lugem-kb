import { themes as prismThemes } from 'prism-react-renderer';

import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';

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
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

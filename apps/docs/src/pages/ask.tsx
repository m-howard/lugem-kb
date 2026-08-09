import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import { type ReactElement } from 'react';

import { AskPanel } from '../components/AskWidget';

const DESCRIPTION =
  'Ask a question in plain language and get an answer drawn from the published documentation, ' +
  'with a link to the page it came from.';

/**
 * A full-page version of the ask panel, for a reader who arrives with a question rather than a
 * destination — and so a conversation has a URL worth sharing.
 *
 * Docusaurus requires a default export for a page. No route conflict with the docs plugin, which
 * owns `/`: nothing in the corpus slugs to `/ask`, and the build fails loudly on a duplicate
 * route, so `bun run docs:build` is the check.
 */
export default function AskPage(): ReactElement {
  return (
    <Layout title="Ask the documentation" description={DESCRIPTION}>
      <main className="container margin-vert--lg">
        <h1>Ask the documentation</h1>
        <p>{DESCRIPTION}</p>
        <p>
          Answers come only from pages that have been merged and indexed. When nothing covers a
          question, you will be told so rather than given a guess.
        </p>
        <BrowserOnly>{() => <AskPanel variant="page" />}</BrowserOnly>
      </main>
    </Layout>
  );
}

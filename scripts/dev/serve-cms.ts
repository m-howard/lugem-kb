#!/usr/bin/env bun
/**
 * The `/admin` editor, running locally against nothing you have to sign up for.
 *
 * ```bash
 * bun run dev:cms          # then open http://127.0.0.1:4300/admin/
 * bun run dev:cms --reset  # throw away yesterday's drafts and reseed from docs/
 * ```
 *
 * The gateway mounts its editorial surface only when a GitHub App and an OIDC issuer are
 * configured, so without this there is no way to open `/admin` without production credentials.
 * Here the app is the real one — the same `createApp`, the same route order, the same branch, path
 * and endpoint policies, real JWT verification — and only its collaborators are local: a git host
 * that keeps what it is given, an identity provider on this origin, and stubbed AWS.
 *
 * Two things make it a place to work rather than a demo. The repository is **stateful**, so a page
 * you save comes back and a draft reaches the editorial board; and it is **persisted**, so
 * `Ctrl-C` does not throw the draft away.
 *
 * `SITE_ROOT` points at `apps/docs/static` rather than a built site. Docusaurus copies `static/`
 * verbatim, so `/admin/` resolves out of it directly and only the editor bundle has to be built
 * first — seconds, rather than a full `docs:build`. Set `SITE_ROOT=apps/docs/build` once you have
 * one and the whole site is served alongside the editor.
 */
import { loadSandboxCorpus } from './sandbox-corpus';
import { createSandboxStore, SANDBOX_STATE_PATH } from './sandbox-store';
import { createApp } from '../../apps/gateway/src/app';
import { Answerer } from '../../apps/gateway/src/kb/answer';
import { CitationViewer } from '../../apps/gateway/src/kb/citation-view';
import { CorpusClient } from '../../apps/gateway/src/kb/corpus-client';
import { Retriever } from '../../apps/gateway/src/kb/retrieve';
// Reused rather than constructing pino here: runtime dependencies resolve from the workspace that
// declares them, and this script lives outside every workspace.
import { createLogger } from '../../apps/gateway/src/logging';
import { createCmsSandbox } from '../../apps/gateway/tests/helpers/cms-sandbox';
import {
  fakeBedrockClient,
  fakeBedrockRuntimeClient,
  fakeS3Client,
} from '../../apps/gateway/tests/helpers/fake-aws';

const DEFAULT_PORT = 4300;
const DEFAULT_SITE_ROOT = 'apps/docs/static';
const IDP_PREFIX = '/idp/';
const CORPUS_PREFIX = 'docs/';
const CORPUS_BUCKET = 'sandbox-corpus';
const SCORE_THRESHOLD = 0.4;
const ANSWER_MAX_TOKENS = 700;
const ASK_RATE_LIMIT_PER_MINUTE = 100;

const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
const siteRoot = process.env['SITE_ROOT'] ?? DEFAULT_SITE_ROOT;
const reset = process.argv.includes('--reset');

/**
 * The origin the *browser* uses, which is not always this server's own.
 *
 * The identity provider's issuer is published to the admin page, which then fetches discovery and
 * exchanges its code against it. Behind `scripts/dev/serve-dev.ts` the browser is on the proxy's
 * port, so an issuer naming this one would be cross-origin — and there is no CORS in this
 * repository. Set `PUBLIC_ORIGIN` to the address you actually open.
 */
const origin = process.env['PUBLIC_ORIGIN'] ?? `http://127.0.0.1:${String(port)}`;

const store = createSandboxStore();
if (reset) {
  await store.discard();
}

/**
 * The published corpus, for the reader half of the service.
 *
 * Read from `docs/` rather than from the sandbox repository: S3 holds what has been *published*,
 * and keeping the two apart is what makes an unmerged draft correctly invisible to `/v1/ask`.
 */
const published = await loadSandboxCorpus();
const stored = await store.load();

const sandbox = await createCmsSandbox({
  origin,
  seed: published,
  state: stored,
  ...(process.env['SANDBOX_AUTHOR_EMAIL'] === undefined
    ? {}
    : {
        author: {
          email: process.env['SANDBOX_AUTHOR_EMAIL'],
          name: process.env['SANDBOX_AUTHOR_NAME'] ?? process.env['SANDBOX_AUTHOR_EMAIL'],
        },
      }),
});

const corpusObjects = Object.fromEntries(
  Object.entries(published)
    .filter(([, file]) => file.encoding !== 'base64')
    .map(([path, file]) => [path, file.content]),
);

const corpus = new CorpusClient({
  s3: fakeS3Client({ objects: corpusObjects }),
  bucket: CORPUS_BUCKET,
  prefix: CORPUS_PREFIX,
});
const viewer = new CitationViewer({
  corpus,
  location: { bucket: CORPUS_BUCKET, prefix: CORPUS_PREFIX },
});
const retriever = new Retriever({
  client: fakeBedrockClient([
    {
      text: 'Bun workspaces keep the monorepo to one lockfile.',
      uri: `s3://${CORPUS_BUCKET}/docs/adr/0001-bun-workspace-monorepo.md`,
      score: 0.88,
    },
  ]),
  knowledgeBaseId: 'KB-SANDBOX',
  scoreThreshold: SCORE_THRESHOLD,
});

const app = createApp({
  corpus,
  retriever,
  viewer,
  answerer: new Answerer({
    client: fakeBedrockRuntimeClient({
      chunks: ['A stubbed answer. Retrieval and generation are not real here. [1]'],
    }),
    retriever,
    viewer,
    modelId: 'sandbox.stub-answer-model',
    maxTokens: ANSWER_MAX_TOKENS,
  }),
  logger: createLogger({ level: process.env['LOG_LEVEL'] ?? 'info', serviceName: 'lugem-sandbox' }),
  siteRoot,
  askRateLimitPerMinute: ASK_RATE_LIMIT_PER_MINUTE,
  corpusPrefix: CORPUS_PREFIX,
  cms: sandbox.dependencies,
});

/**
 * The identity provider goes in front of the app rather than inside it.
 *
 * `createApp` owns its route order — the site catch-all has to stay last — and the point of
 * running the real app locally is to run it as it ships, not a variant with development routes
 * threaded through it.
 */
const server = Bun.serve({
  port,
  fetch: async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(IDP_PREFIX)) {
      return sandbox.idp.routes.fetch(new Request(request.url.replace(IDP_PREFIX, '/'), request));
    }

    const response = await app.fetch(request);
    // After the response, not before: a save is several mutating calls, and the debounce in the
    // store collapses them into one write.
    if (sandbox.host.isDirty()) {
      sandbox.host.markClean();
      store.save(() => sandbox.host.repo.snapshot());
    }
    return response;
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void store.flush().then(async () => {
      await server.stop();
      process.exit(0);
    });
  });
}

const fileCount = Object.keys(stored?.blobs ?? published).length;

console.log(`The documentation CMS sandbox is on ${origin}/admin/`);
console.log(`  listening    http://127.0.0.1:${String(port)}`);
console.log(`  repository   ${sandbox.settings.repository} (local, not a real git host)`);
console.log(
  `  corpus       ${String(fileCount)} files, ` +
    (stored === undefined ? 'seeded from docs/' : `restored from ${SANDBOX_STATE_PATH}`),
);
console.log(`  signed in as ${sandbox.author.name} <${sandbox.author.email}>`);
console.log(`  site root    ${siteRoot}`);
console.log('  start over   bun run dev:cms --reset');

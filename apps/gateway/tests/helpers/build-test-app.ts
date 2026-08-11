import { type Hono } from 'hono';
import { generateKeyPair } from 'jose';
import { pino } from 'pino';

import {
  type FakeAnswerOptions,
  fakeBedrockClient,
  fakeBedrockRuntimeClient,
  type FakeRetrievalResult,
  fakeS3Client,
} from './fake-aws';
import { type CollectingRecorder } from './fake-feedback';
import { type FakeGitHost, fakeGitHost } from './fake-git-host';
import { type FakeGitHub, type FakeGitHubRoute, fakeGitHub } from './fake-github';
import { type FakeIdp, fakeIdp } from './fake-idp';
import { type SeedFile } from './git-repo';
import { createApp } from '../../src/app';
import { type AppEnv } from '../../src/app-env';
import { createBearerVerifier } from '../../src/auth/bearer-verifier';
import { type IdentityVerifier } from '../../src/auth/verifier';
import { type CmsDependencies } from '../../src/cms/dependencies';
import { DocumentReader } from '../../src/cms/documents';
import { DraftService } from '../../src/cms/drafts';
import { MediaService } from '../../src/cms/media';
import { type CmsSettings } from '../../src/cms/settings';
import { SubmissionService } from '../../src/cms/submissions';
import { GitHubClient } from '../../src/git/github-client';
import { InstallationTokenSource } from '../../src/git/installation-token';
import { Answerer } from '../../src/kb/answer';
import { CitationViewer } from '../../src/kb/citation-view';
import { CorpusClient } from '../../src/kb/corpus-client';
import { Retriever } from '../../src/kb/retrieve';
import { PreviewClient } from '../../src/previews/preview-client';

export const TEST_BUCKET = 'test-corpus';
export const TEST_PREFIX = 'docs/';
export const TEST_SITE_ROOT = 'apps/gateway/tests/fixtures/site';
export const TEST_PREVIEW_BUCKET = 'test-previews';
export const TEST_PREVIEW_BASE_URL = 'https://kb.test/previews';

export const TEST_REPOSITORY = 'acme/handbook';
export const TEST_GITHUB_API = 'https://api.github.test';
export const TEST_PUBLISHER_CLIENT_ID = 'lugem-cms-admin';

export const TEST_MEDIA_FOLDER = 'docs/assets/media/';

/** Small enough that a test can exceed it with a literal, rather than a megabyte of fixture. */
export const TEST_MAX_UPLOAD_BYTES = 4096;

export const TEST_CMS_SETTINGS: CmsSettings = {
  repository: TEST_REPOSITORY,
  defaultBranch: 'main',
  branchPrefix: 'cms/',
  pathPrefixes: ['docs/'],
  mediaFolder: TEST_MEDIA_FOLDER,
  maxUploadBytes: TEST_MAX_UPLOAD_BYTES,
};

/** Silent unless a test wants the records, in which case they are parsed back into objects. */
function createTestLogger(sink: Record<string, unknown>[] | undefined) {
  if (sink === undefined) {
    return pino({ level: 'silent' });
  }
  return pino(
    { level: 'trace', formatters: { level: (label) => ({ level: label }) } },
    { write: (line: string) => sink.push(JSON.parse(line) as Record<string, unknown>) },
  );
}

const TEST_SCORE_THRESHOLD = 0.4;
const TEST_ANSWER_MAX_TOKENS = 700;
const TEST_ASK_RATE_LIMIT = 100;

export interface TestAppOptions {
  readonly objects?: Readonly<Record<string, string>>;
  readonly retrievalResults?: readonly FakeRetrievalResult[];
  readonly corpusUnreachable?: boolean;
  readonly siteRoot?: string;
  /** Answer streaming behaviour. Defaults to a single chunk. */
  readonly answer?: FakeAnswerOptions;
  /** Requests per client per minute on `/v1/ask`. High by default so tests do not trip it. */
  readonly askRateLimitPerMinute?: number;
  /** Present only when a test switches the CMS on, mirroring the CMS_REPOSITORY master switch. */
  readonly cms?: CmsDependencies | undefined;
  /**
   * Present only when a test switches gap recording on, mirroring the GAP_FEEDBACK_TABLE master
   * switch. Absent means `/v1/feedback` is not mounted and no gap is recorded — see
   * `collectingRecorder` in `fake-feedback.ts`.
   */
  readonly feedback?: CollectingRecorder | undefined;
  /**
   * Present only when a test switches reader authentication on, mirroring READER_AUTH_REQUIRED.
   * Absent means the reader routes are open, which is the default deployment — see ADR 0017.
   */
  readonly readerVerifier?: IdentityVerifier | undefined;
  /**
   * Present only when a test switches previews on, mirroring the PREVIEW_BUCKET master switch.
   * Keys are relative to the preview bucket root, e.g. `pr-42/index.html`.
   */
  readonly previewObjects?: Readonly<Record<string, string>> | undefined;
  /**
   * Makes the preview bucket answer `AccessDenied` for anything it does not hold — a deployment
   * whose task role, bucket policy or encryption grant is wrong, rather than a build that has not
   * finished. Only meaningful alongside `previewObjects`.
   */
  readonly previewsRefused?: boolean | undefined;
  /** Collects log records instead of discarding them, for tests that assert on audit output. */
  readonly captureLogs?: Record<string, unknown>[] | undefined;
}

/** Everything a CMS harness gives a test, whichever git host is behind it. */
export interface TestCmsHarness {
  readonly app: Hono<AppEnv>;
  readonly idp: FakeIdp;
  readonly dependencies: CmsDependencies;
  /** `Authorization` header for the given claims, defaulting to a valid author. */
  authorize(claims?: Record<string, unknown>): Promise<Record<string, string>>;
}

export interface TestCms extends TestCmsHarness {
  readonly host: FakeGitHub;
}

/** The same harness over a git host that keeps what it is given — see `fake-git-host.ts`. */
export interface StatefulTestCms extends TestCmsHarness {
  readonly host: FakeGitHost;
}

export interface TestCmsOptions {
  readonly routes?: readonly FakeGitHubRoute[];
  readonly settings?: Partial<CmsSettings>;
  readonly allowMergeFromCms?: boolean;
  /** Status the token mint answers with. 401 is what an unwritten credential secret looks like. */
  readonly mintStatus?: number;
  /** Collects the audit records the app writes, so R9 can be asserted rather than assumed. */
  readonly captureLogs?: Record<string, unknown>[];
  /**
   * Where previews are served from, when a test wants the CMS workflow card to offer one.
   * Undefined — the default — is a deployment with no preview bucket, where R12's link is absent.
   */
  readonly previewBaseUrl?: string;
}

/** Options for the stateful harness. `seed` is the corpus the sandbox repository starts with. */
export interface StatefulTestCmsOptions {
  readonly seed?: Readonly<Record<string, SeedFile>>;
  /**
   * A host built by the caller, when the test needs to hold it before the app exists — to observe
   * the calls, or to wrap `fetch` so something happens between a read and the write that follows.
   */
  readonly host?: FakeGitHost;
  readonly settings?: Partial<CmsSettings>;
  readonly allowMergeFromCms?: boolean;
  readonly captureLogs?: Record<string, unknown>[];
  readonly previewBaseUrl?: string;
}

/**
 * Builds the real app with the CMS switched on, over a fake git host and a real key pair.
 *
 * Every collaborator is the production one: the same `createApp`, the same policies, real JWT
 * verification against a generated key. Only the network is faked — and the fake refuses any call
 * a test did not declare, so an unexpected upstream request fails rather than passing quietly.
 *
 * @param options - Upstream routes the test expects, settings overrides, and the merge flag.
 * @returns The app, the issuer, the git host, and a helper that mints an Authorization header.
 */
export async function buildCmsTestApp(options: TestCmsOptions = {}): Promise<TestCms> {
  const host = fakeGitHub(
    options.routes ?? [],
    options.mintStatus === undefined ? {} : { mintStatus: options.mintStatus },
  );

  return { ...(await buildCmsHarness(host.fetch, options)), host };
}

/**
 * The same harness over a repository that remembers what was written to it.
 *
 * Use this when the assertion is about the editorial workflow — that a saved page is readable
 * afterwards, that a draft branch reaches the board, that a submission becomes a pull request.
 * Use {@link buildCmsTestApp} when the assertion is about which upstream calls were made, which is
 * what guards the endpoint allowlist.
 *
 * @param options - The seed corpus, settings overrides, and the merge flag.
 * @returns The app, the issuer, the live git host, and an Authorization helper.
 */
export async function buildStatefulCmsTestApp(
  options: StatefulTestCmsOptions = {},
): Promise<StatefulTestCms> {
  const settings: CmsSettings = { ...TEST_CMS_SETTINGS, ...options.settings };
  const host =
    options.host ??
    fakeGitHost({
      repository: settings.repository,
      defaultBranch: settings.defaultBranch,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });

  return { ...(await buildCmsHarness(host.fetch, options)), host };
}

interface CmsHarnessOptions {
  readonly settings?: Partial<CmsSettings>;
  readonly allowMergeFromCms?: boolean;
  readonly captureLogs?: Record<string, unknown>[];
  readonly previewBaseUrl?: string;
}

/**
 * Assembles the CMS dependency graph over an injected `fetch`.
 *
 * Shared by both harnesses so the two differ in exactly one thing — which git host is behind
 * them — rather than in fifty lines of duplicated wiring that could drift apart.
 */
async function buildCmsHarness(
  upstream: typeof globalThis.fetch,
  options: CmsHarnessOptions,
): Promise<TestCmsHarness> {
  const idp = await fakeIdp();
  const settings: CmsSettings = { ...TEST_CMS_SETTINGS, ...options.settings };
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });

  const tokens = new InstallationTokenSource({
    appId: '123456',
    installationId: '78901234',
    loadPrivateKey: () => Promise.resolve(privateKey),
    apiBaseUrl: TEST_GITHUB_API,
    fetch: upstream,
  });
  const client = new GitHubClient({
    tokens,
    repository: settings.repository,
    apiBaseUrl: TEST_GITHUB_API,
    allowMergeFromCms: options.allowMergeFromCms ?? false,
    fetch: upstream,
  });

  const dependencies: CmsDependencies = {
    settings,
    tokens,
    client,
    reader: new DocumentReader({ client, settings }),
    drafts: new DraftService({ client, settings }),
    media: new MediaService({ client, settings }),
    submissions: new SubmissionService({
      client,
      settings,
      allowMerge: options.allowMergeFromCms ?? false,
    }),
    verifier: createBearerVerifier({
      issuer: idp.issuer,
      audience: idp.audience,
      claimNames: { email: 'email', name: 'name' },
      keyResolver: idp.keyResolver,
    }),
    auth: {
      mode: 'bearer',
      issuer: idp.issuer,
      audience: idp.audience,
      clientId: TEST_PUBLISHER_CLIENT_ID,
      emailClaim: 'email',
      nameClaim: 'name',
    },
    allowMergeFromCms: options.allowMergeFromCms ?? false,
    previewBaseUrl: options.previewBaseUrl,
  };

  return {
    app: buildTestApp({
      cms: dependencies,
      ...(options.captureLogs === undefined ? {} : { captureLogs: options.captureLogs }),
    }),
    idp,
    dependencies,
    async authorize(claims = { sub: 'a1b2', email: 'sam@example.com', name: 'Sam Okoro' }) {
      return { authorization: `Bearer ${await idp.sign(claims)}` };
    },
  };
}

/**
 * Assembles the real app over fake AWS clients.
 *
 * The app is built by the same `createApp` production uses, so route ordering — the thing these
 * tests exist to protect — is exercised exactly as deployed.
 *
 * @param options - Corpus contents, retrieval results, answer behaviour, and failure toggles.
 * @returns The app, ready for `app.request(...)`.
 */
export function buildTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const s3 = fakeS3Client({
    objects: options.objects ?? {},
    ...(options.corpusUnreachable === undefined ? {} : { unreachable: options.corpusUnreachable }),
  });

  const corpus = new CorpusClient({ s3, bucket: TEST_BUCKET, prefix: TEST_PREFIX });
  const viewer = new CitationViewer({
    corpus,
    location: { bucket: TEST_BUCKET, prefix: TEST_PREFIX },
  });
  const retriever = new Retriever({
    client: fakeBedrockClient(options.retrievalResults ?? []),
    knowledgeBaseId: 'KB-TEST',
    scoreThreshold: TEST_SCORE_THRESHOLD,
  });

  return createApp({
    corpus,
    retriever,
    viewer,
    answerer: new Answerer({
      client: fakeBedrockRuntimeClient(options.answer ?? { chunks: ['A grounded answer.'] }),
      retriever,
      viewer,
      modelId: 'test.answer-model-v1:0',
      maxTokens: TEST_ANSWER_MAX_TOKENS,
    }),
    // Silent by default: these tests assert on HTTP responses, and pino's output would drown the
    // reporter. A test that asserts on audit records passes a sink instead.
    logger: createTestLogger(options.captureLogs),
    siteRoot: options.siteRoot ?? TEST_SITE_ROOT,
    askRateLimitPerMinute: options.askRateLimitPerMinute ?? TEST_ASK_RATE_LIMIT,
    corpusPrefix: TEST_PREFIX,
    ...(options.cms === undefined ? {} : { cms: options.cms }),
    ...(options.feedback === undefined ? {} : { recorder: options.feedback.recorder }),
    ...(options.readerVerifier === undefined ? {} : { readerVerifier: options.readerVerifier }),
    // A second bucket, not a second prefix on the corpus one — the same separation production has,
    // so a preview key can never be reached through the corpus client by accident. See ADR 0018.
    ...(options.previewObjects === undefined
      ? {}
      : {
          previews: new PreviewClient({
            s3: fakeS3Client({
              objects: options.previewObjects,
              ...(options.previewsRefused === undefined
                ? {}
                : { refuseMissing: options.previewsRefused }),
            }),
            bucket: TEST_PREVIEW_BUCKET,
          }),
        }),
  });
}

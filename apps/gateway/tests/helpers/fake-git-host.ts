import {
  branchOf,
  BLOB_MODE,
  GitRepo,
  GitRepoError,
  type RepoState,
  type SeedFile,
} from './git-repo';
import { requestUrl } from './request-url';

/**
 * A stand-in git host backed by a real repository model, rather than a table of canned answers.
 *
 * `fake-github.ts` remains the right tool for a test asserting *which* upstream calls a route makes:
 * it refuses anything undeclared, which is how the endpoint allowlist is guarded. This one answers
 * a different question — whether the editorial workflow actually works — by keeping the objects a
 * save creates so the next read returns them. That is what a person doing local development needs,
 * and it is what lets an integration test assert a round trip instead of a fixture.
 *
 * Only the allowlisted surface is implemented (`src/git/endpoint-policy.ts`), plus the installation
 * token mint. Anything else answers `404`, as the real host would for a path that does not exist.
 *
 * The `fetch` it exposes is injected into `GitHubClient` and `InstallationTokenSource`, so the
 * gateway above it is unmodified production code in both the integration tests and the sandbox.
 */

const OK = 200;
const CREATED = 201;
const NO_CONTENT = 204;
const NOT_FOUND = 404;
const INTERNAL_ERROR = 500;

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface FakeGitHostOptions {
  /** `owner/name`. Every path is checked against it, as the real host's routing would be. */
  readonly repository: string;
  readonly defaultBranch?: string;
  /** Initial corpus, used only when `state` is absent. */
  readonly seed?: Readonly<Record<string, SeedFile>>;
  /** A previously captured {@link RepoState}, for a sandbox restoring yesterday's drafts. */
  readonly state?: RepoState;
  /** Where pull requests claim to live, for the `html_url` an author follows. */
  readonly webBaseUrl?: string;
}

export interface FakeGitHost {
  /** Inject into `GitHubClient` / `InstallationTokenSource`. */
  readonly fetch: typeof globalThis.fetch;
  /** The repository itself, for a caller that wants to look at or seed it directly. */
  readonly repo: GitRepo;
  /** Whether any request since the last snapshot changed the repository. */
  isDirty(): boolean;
  markClean(): void;
}

interface RouteContext {
  readonly repo: GitRepo;
  readonly repository: string;
  readonly webBaseUrl: string;
  readonly rest: string;
  readonly search: URLSearchParams;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** A pull request in the shape `cms/submissions.ts` reads: it uses these fields and no others. */
function pullBody(context: RouteContext, number: number): Record<string, unknown> {
  const pull = context.repo.readPull(number);

  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    // Always mergeable here: there is no second writer to conflict with in a sandbox, and the
    // gateway treats `null` as "not worked out yet" rather than as a refusal.
    mergeable: true,
    html_url: `${context.webBaseUrl}/${context.repository}/pull/${String(pull.number)}`,
    head: { ref: pull.head, repo: { full_name: context.repository } },
    base: { ref: pull.base },
  };
}

function json(payload: unknown, status = OK): Response {
  return Response.json(payload, { status });
}

/**
 * Reads a string field from a request body.
 *
 * Narrowed rather than coerced: a caller sending an object where the git API expects a sha should
 * see the field treated as absent, not stored as the string `[object Object]`.
 */
function text(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

/** `GET` routes below `/repos/:owner/:name`. Split out to keep each function under review size. */
function readRoutes(context: RouteContext): Response | undefined {
  const { repo, rest } = context;

  const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
  if (ref !== null) {
    const branch = decodeBranch(ref[1] ?? '');
    const sha = repo.getRef(branch);
    return sha === undefined
      ? json({ message: 'Not Found' }, NOT_FOUND)
      : json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
  }

  const matching = /^\/git\/matching-refs\/heads\/(.*)$/.exec(rest);
  if (matching !== null) {
    const prefix = decodeBranch(matching[1] ?? '');
    return json(
      repo.matchingRefs(prefix).map((branch) => ({
        ref: `refs/heads/${branch}`,
        object: { sha: repo.getRef(branch), type: 'commit' },
      })),
    );
  }

  const commit = /^\/git\/commits\/([^/]+)$/.exec(rest);
  if (commit !== null) {
    const object = repo.readCommit(commit[1] ?? '');
    return json({
      sha: commit[1],
      message: object.message,
      tree: { sha: object.tree },
      parents: object.parents.map((sha) => ({ sha })),
      author: object.author,
      committer: object.committer,
    });
  }

  const tree = /^\/git\/trees\/([^/]+)$/.exec(rest);
  if (tree !== null) {
    const files = repo.readTree(tree[1] ?? '');
    return json({
      sha: tree[1],
      // Never truncated: `readTreeEntries` treats truncation as a failure, and a sandbox corpus is
      // four orders of magnitude below where a real host would start truncating.
      truncated: false,
      tree: Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, sha]) => ({
          path,
          mode: BLOB_MODE,
          type: 'blob',
          sha,
          size: repo.blobSize(sha),
        })),
    });
  }

  const blob = /^\/git\/blobs\/([^/]+)$/.exec(rest);
  if (blob !== null) {
    return json({ sha: blob[1], content: repo.readBlob(blob[1] ?? ''), encoding: 'base64' });
  }

  return undefined;
}

/** Everything that changes the repository: blobs, trees, commits and refs. */
function writeRoutes(context: RouteContext): Response | undefined {
  const { repo, rest, method, body } = context;

  if (method === 'POST' && rest === '/git/blobs') {
    const content = text(body, 'content');
    const base64 =
      text(body, 'encoding', 'utf-8') === 'base64'
        ? content
        : Buffer.from(content, 'utf8').toString('base64');
    return json({ sha: repo.createBlob(base64) }, CREATED);
  }

  if (method === 'POST' && rest === '/git/trees') {
    const entries = (body['tree'] as { path?: string; sha?: string | null }[] | undefined) ?? [];
    const baseTree = text(body, 'base_tree');
    const sha = repo.createTree(
      baseTree === '' ? undefined : baseTree,
      entries.map((entry) => ({ path: entry.path ?? '', sha: entry.sha ?? null })),
    );
    return json({ sha }, CREATED);
  }

  if (method === 'POST' && rest === '/git/commits') {
    const author = body['author'] as { name?: string; email?: string } | undefined;
    const sha = repo.createCommit({
      message: text(body, 'message'),
      tree: text(body, 'tree'),
      parents: (body['parents'] as string[] | undefined) ?? [],
      // The gateway sends `author` and deliberately omits `committer`, leaving the App as the
      // committer — see `git/attribution.ts`. The model fills that in, as the real host does.
      ...(author === undefined ? {} : { author: withDate(author) }),
    });
    return json({ sha }, CREATED);
  }

  if (method === 'POST' && rest === '/git/refs') {
    const branch = branchOf(text(body, 'ref'));
    const sha = text(body, 'sha');
    repo.createRef(branch, sha);
    return json({ ref: `refs/heads/${branch}`, object: { sha } }, CREATED);
  }

  const refPath = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (refPath !== null && method === 'PATCH') {
    const branch = decodeBranch(refPath[1] ?? '');
    const sha = text(body, 'sha');
    repo.updateRef(branch, sha, body['force'] === true);
    return json({ ref: `refs/heads/${branch}`, object: { sha } });
  }
  if (refPath !== null && method === 'DELETE') {
    repo.deleteRef(decodeBranch(refPath[1] ?? ''));
    return new Response(null, { status: NO_CONTENT });
  }

  return undefined;
}

function pullRoutes(context: RouteContext): Response | undefined {
  const { repo, rest, search, method, body } = context;
  const describe = (number: number): Record<string, unknown> => pullBody(context, number);

  if (rest === '/pulls' && method === 'GET') {
    // `head` arrives as `owner:branch`; only the branch half is meaningful in one repository.
    const head = search.get('head')?.split(':').slice(1).join(':');
    return json(
      repo
        .listPulls({
          state: search.get('state') ?? undefined,
          ...(head === undefined || head === '' ? {} : { head }),
        })
        .map((pull) => describe(pull.number)),
    );
  }

  if (rest === '/pulls' && method === 'POST') {
    const pull = repo.createPull({
      title: text(body, 'title'),
      body: text(body, 'body'),
      head: branchOf(text(body, 'head')),
      base: branchOf(text(body, 'base')),
    });
    return json(describe(pull.number), CREATED);
  }

  const one = /^\/pulls\/(\d+)$/.exec(rest);
  if (one !== null) {
    const number = Number(one[1]);
    if (method === 'GET') {
      repo.readPull(number);
      return json(describe(number));
    }
    if (method === 'PATCH') {
      if (text(body, 'state') === 'closed') {
        repo.closePull(number);
      }
      return json(describe(number));
    }
  }

  const merge = /^\/pulls\/(\d+)\/merge$/.exec(rest);
  if (merge !== null && method === 'PUT') {
    const { sha } = repo.mergePull(Number(merge[1]));
    return json({ sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return undefined;
}

function withDate(author: { name?: string; email?: string }): {
  name: string;
  email: string;
  date: string;
} {
  return {
    name: author.name ?? '',
    email: author.email ?? '',
    date: new Date().toISOString(),
  };
}

/** Ref path segments are percent-encoded one at a time — see `git/branch-policy.ts`. */
function decodeBranch(path: string): string {
  return path.split('/').map(decodeURIComponent).join('/');
}

/**
 * Builds a git host over a live repository model.
 *
 * @param options - The repository name, and either a seed corpus or a restored state.
 * @returns An injectable `fetch` and the repository behind it.
 */
export function fakeGitHost(options: FakeGitHostOptions): FakeGitHost {
  const defaultBranch = options.defaultBranch ?? 'main';
  const webBaseUrl = options.webBaseUrl ?? 'https://github.test';
  const repo = new GitRepo(options.state);
  if (options.state === undefined) {
    repo.seed(defaultBranch, options.seed ?? {});
  }

  let dirty = false;

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = decodeURI(url.pathname);

    if (path.startsWith('/app/installations/')) {
      return json(
        {
          token: 'ghs_sandbox_installation_token',
          expires_at: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
        },
        CREATED,
      );
    }

    const scoped = new RegExp(`^/repos/${options.repository}(/.*)?$`, 'i').exec(path);
    if (scoped === null) {
      return json({ message: 'Not Found' }, NOT_FOUND);
    }

    const context: RouteContext = {
      repo,
      repository: options.repository,
      webBaseUrl,
      rest: scoped[1] ?? '',
      search: url.searchParams,
      method,
      body: await readJson(request),
    };

    try {
      const response =
        (method === 'GET' ? readRoutes(context) : undefined) ??
        writeRoutes(context) ??
        pullRoutes(context) ??
        json({ message: 'Not Found' }, NOT_FOUND);
      if (method !== 'GET' && response.status < NOT_FOUND) {
        dirty = true;
      }
      return response;
    } catch (error) {
      if (error instanceof GitRepoError) {
        return json({ message: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return json({ message }, INTERNAL_ERROR);
    }
  };

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    handle(new Request(requestUrl(input), init))) as typeof globalThis.fetch;

  return {
    fetch: fetchImpl,
    repo,
    isDirty: () => dirty,
    markClean: () => {
      dirty = false;
    },
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET' || request.method === 'DELETE') {
    return {};
  }
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

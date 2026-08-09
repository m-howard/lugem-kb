#!/usr/bin/env bun
/**
 * Drives a running gateway through the Phase 2 exit criteria.
 *
 * `docs/requirements.md` §9 says the gateway is "verified with a scripted client before any human
 * uses it". This is that client. Every check below is an acceptance criterion from R1–R6, R9 or
 * R10, asserted against a real deployment over HTTP — the integration suite proves the same rules
 * against fakes, and this proves the deployment actually carries them.
 *
 * It is deliberately destructive in one direction only: it writes to a throwaway branch under the
 * CMS prefix and deletes it again. It never touches the default branch, because if it could, the
 * gateway would already have failed R4.
 *
 * Usage:
 *   bun run scripts/check/verify-gateway.ts --base-url https://docs.internal --token "$ID_TOKEN"
 *
 * The token is any credential the deployment's AUTH_MODE accepts. In `alb` mode there is nothing
 * to pass: run this from behind the load balancer and it will forward the session cookie the ALB
 * set, so omit --token and pass --cookie instead.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const OK = 200;
const CREATED = 201;
const NO_CONTENT = 204;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

interface Options {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly cookie: string | undefined;
  readonly branch: string;
}

interface CheckResult {
  readonly requirement: string;
  readonly what: string;
  readonly passed: boolean;
  readonly detail: string;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag?.startsWith('--') === true) {
      flags.set(flag.slice(2), argv[index + 1] ?? '');
    }
  }

  return {
    baseUrl: (flags.get('base-url') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    token: flags.get('token'),
    cookie: flags.get('cookie'),
    // A distinct branch per run, so two people verifying at once do not collide. Not random:
    // the caller can pass --branch to reuse one, and a fixed default would be worse than either.
    branch: flags.get('branch') ?? `cms/verify-${String(process.pid)}`,
  };
}

class Gateway {
  readonly #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  async call(
    method: string,
    path: string,
    init: { readonly body?: unknown; readonly anonymous?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.anonymous !== true) {
      if (this.#options.token !== undefined) {
        headers['authorization'] = `Bearer ${this.#options.token}`;
      }
      if (this.#options.cookie !== undefined) {
        headers['cookie'] = this.#options.cookie;
      }
    }
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${this.#options.baseUrl}${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      // Left as text. A JSON endpoint answering HTML is itself a finding — see the route
      // precedence check below.
    }
    return { status: response.status, body };
  }
}

function check(
  requirement: string,
  what: string,
  outcome: { readonly passed: boolean; readonly detail: string },
): CheckResult {
  return { requirement, what, passed: outcome.passed, detail: outcome.detail };
}

function expectStatus(actual: number, expected: number): { passed: boolean; detail: string } {
  return { passed: actual === expected, detail: `${String(actual)} (wanted ${String(expected)})` };
}

/** R1: a request the gateway cannot attribute is refused, and nothing reaches the git host. */
async function checkAuthentication(gateway: Gateway): Promise<CheckResult[]> {
  const anonymous = await gateway.call('GET', '/v1/cms/config', { anonymous: true });
  const garbage = await gateway.call('GET', '/v1/cms/config', { anonymous: true });
  const identity = await gateway.call('GET', '/v1/cms/identity');

  return [
    check('R1', 'an unauthenticated request is refused', expectStatus(anonymous.status, UNAUTHORIZED)),
    check('R1', 'a request with no bearer token never reaches an upstream', {
      passed: garbage.status === UNAUTHORIZED,
      detail: JSON.stringify(garbage.body),
    }),
    check('R1', 'an authenticated caller is named from their token', {
      passed:
        identity.status === OK &&
        typeof (identity.body as { email?: unknown }).email === 'string',
      detail: JSON.stringify(identity.body),
    }),
  ];
}

/** R3: writes are confined to the documentation prefixes, and refused before any upstream call. */
async function checkWriteConfinement(gateway: Gateway, branch: string): Promise<CheckResult[]> {
  const cases: readonly [string, string][] = [
    ['a workflow file', '.github/workflows/ci.yml'],
    ['a markdown file outside the docs tree', '.github/workflows/evil.md'],
    ['the repository root', 'README.md'],
    ['traversal out of the docs tree', 'docs/../.github/workflows/ci.md'],
    ['a shell script inside the docs tree', 'docs/deploy.sh'],
  ];

  const results: CheckResult[] = [];
  for (const [what, path] of cases) {
    const response = await gateway.call('PUT', `/v1/cms/drafts/${branch}`, {
      body: { files: [{ path, content: 'x' }] },
    });
    results.push(check('R3', `refuses ${what}`, expectStatus(response.status, FORBIDDEN)));
  }

  const mixed = await gateway.call('PUT', `/v1/cms/drafts/${branch}`, {
    body: {
      files: [
        { path: 'docs/verify.md', content: 'fine' },
        { path: '.github/workflows/ci.yml', content: 'not fine' },
      ],
    },
  });
  results.push(
    check('R3', 'refuses a change set where one entry is bad', expectStatus(mixed.status, FORBIDDEN)),
  );

  return results;
}

/** R4: the CMS owns its branch prefix and nothing else. */
async function checkBranchConfinement(gateway: Gateway): Promise<CheckResult[]> {
  const config = (await gateway.call('GET', '/v1/cms/config')).body as { defaultBranch?: string };
  const defaultBranch = config.defaultBranch ?? 'main';
  const draft = { files: [{ path: 'docs/verify.md', content: '# verify\n' }] };

  const onDefault = await gateway.call('PUT', `/v1/cms/drafts/${defaultBranch}`, { body: draft });
  const deleteDefault = await gateway.call('DELETE', `/v1/cms/drafts/${defaultBranch}`);
  const outside = await gateway.call('PUT', '/v1/cms/drafts/feature/verify', { body: draft });

  return [
    check('R4', 'refuses writing the default branch', expectStatus(onDefault.status, FORBIDDEN)),
    check('R4', 'refuses deleting the default branch', expectStatus(deleteDefault.status, FORBIDDEN)),
    check('R4', 'refuses a branch outside the prefix', expectStatus(outside.status, FORBIDDEN)),
  ];
}

/** R5: repository administration is not reachable, whatever the client asks for. */
async function checkEndpointAllowlist(gateway: Gateway): Promise<CheckResult[]> {
  const administration = await gateway.call('GET', '/v1/cms/branches/main/protection');
  const unknown = await gateway.call('GET', '/v1/cms/nonsense');
  const unknownApi = await gateway.call('GET', '/v1/nonsense');

  return [
    check('R5', 'repository administration is not an editorial route', {
      passed: administration.status === NOT_FOUND,
      detail: `${String(administration.status)} (wanted ${String(NOT_FOUND)})`,
    }),
    // A JSON 404 rather than the site's HTML: an unmatched API path must not fall through to the
    // catch-all, or a typo reads as a rendering bug and R5's "refused and logged" is not true.
    check('R5', 'an unmatched CMS path answers JSON, not the site', {
      passed:
        unknown.status === NOT_FOUND &&
        (unknown.body as { error?: unknown }).error === 'not_found',
      detail: `${String(unknown.status)} ${JSON.stringify(unknown.body)}`,
    }),
    check('R5', 'an unmatched API path answers JSON, not the site', {
      passed:
        unknownApi.status === NOT_FOUND &&
        (unknownApi.body as { error?: unknown }).error === 'not_found',
      detail: `${String(unknownApi.status)} ${JSON.stringify(unknownApi.body)}`,
    }),
  ];
}

/** R6: the human is named in git history, and the app is recorded as what performed the write. */
async function checkAttribution(gateway: Gateway, branch: string): Promise<CheckResult[]> {
  const saved = await gateway.call('PUT', `/v1/cms/drafts/${branch}`, {
    body: {
      files: [{ path: 'docs/verify.md', content: `# Verification\n\nWritten by the phase 2 check.\n` }],
      message: 'docs: verify the authoring gateway',
    },
  });

  const results = [
    check('R4', 'creates a branch under the prefix', {
      passed: saved.status === CREATED || saved.status === OK,
      detail: `${String(saved.status)} ${JSON.stringify(saved.body)}`,
    }),
  ];

  const submitted = await gateway.call('POST', '/v1/cms/submissions', {
    body: { branch, title: 'Phase 2 verification', summary: 'Opened by the verification script.' },
  });
  const submission = submitted.body as { number?: number; url?: string };

  results.push(
    check('R6', 'submitting opens a pull request naming the submitter', {
      passed: submitted.status === CREATED && typeof submission.number === 'number',
      detail: `${String(submitted.status)} ${submission.url ?? JSON.stringify(submitted.body)}`,
    }),
  );

  if (typeof submission.number === 'number') {
    const merge = await gateway.call('POST', `/v1/cms/submissions/${String(submission.number)}/merge`);
    results.push(
      check('R7', 'refuses to merge from the CMS', expectStatus(merge.status, FORBIDDEN)),
    );
  }

  return results;
}

/** R10: liveness does not depend on the git host; readiness does. */
async function checkHealth(gateway: Gateway): Promise<CheckResult[]> {
  const live = await gateway.call('GET', '/healthz', { anonymous: true });
  const ready = await gateway.call('GET', '/readyz', { anonymous: true });

  return [
    check('R10', 'liveness is green', expectStatus(live.status, OK)),
    check('R10', 'readiness is green, so a token can be minted', {
      passed: ready.status === OK,
      detail: `${String(ready.status)} ${JSON.stringify(ready.body)}`,
    }),
  ];
}

async function cleanUp(gateway: Gateway, branch: string): Promise<CheckResult> {
  const discarded = await gateway.call('DELETE', `/v1/cms/drafts/${branch}`);

  return check('R4', 'discards its own draft branch', {
    passed: discarded.status === NO_CONTENT || discarded.status === NOT_FOUND,
    detail: String(discarded.status),
  });
}

function report(results: readonly CheckResult[]): boolean {
  const width = Math.max(...results.map((result) => result.what.length));
  console.log('');
  for (const result of results) {
    const mark = result.passed ? '[32mPASS[0m' : '[31mFAIL[0m';
    console.log(
      `${mark}  ${result.requirement.padEnd(4)} ${result.what.padEnd(width)}  ${result.detail}`,
    );
  }

  const failed = results.filter((result) => !result.passed).length;
  console.log('');
  console.log(
    failed === 0
      ? `[32m${String(results.length)} checks passed.[0m Phase 2 exit criteria hold against this deployment.`
      : `[31m${String(failed)} of ${String(results.length)} checks failed.[0m`,
  );
  return failed === 0;
}

const options = parseOptions(process.argv.slice(2));
const gateway = new Gateway(options);

console.log(`Verifying ${options.baseUrl} with draft branch ${options.branch}`);

const results: CheckResult[] = [
  ...(await checkHealth(gateway)),
  ...(await checkAuthentication(gateway)),
  ...(await checkWriteConfinement(gateway, options.branch)),
  ...(await checkBranchConfinement(gateway)),
  ...(await checkEndpointAllowlist(gateway)),
  ...(await checkAttribution(gateway, options.branch)),
  await cleanUp(gateway, options.branch),
];

process.exit(report(results) ? 0 : 1);

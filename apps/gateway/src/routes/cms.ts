import { type Context, Hono } from 'hono';
import { type ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import { type AppEnv } from '../app-env';
import { type AuditRecord, recordAudit } from '../audit';
import { type createAuthMiddleware } from '../auth/middleware';
import { createCredentialGuard } from '../cms/credential-guard';
import { dispatch } from '../cms/decap/dispatch';
import { proxyRequestSchema } from '../cms/decap/protocol';
import { DocumentMissingError, type DocumentReader } from '../cms/documents';
import { type DraftService } from '../cms/drafts';
import { CmsPolicyError, DraftMissingError, UnsupportedActionError } from '../cms/errors';
import { type CmsSettings } from '../cms/settings';
import { type SubmissionService } from '../cms/submissions';
import { EndpointPolicyError, type GitHubClient, GitHubError } from '../git/github-client';
import { type InstallationTokenSource } from '../git/installation-token';
import { PERMITTED_EXTENSIONS } from '../kb/key-policy';

const BAD_REQUEST: ContentfulStatusCode = 400;
const FORBIDDEN: ContentfulStatusCode = 403;
const NOT_FOUND: ContentfulStatusCode = 404;
const CONFLICT: ContentfulStatusCode = 409;
const UNPROCESSABLE = 422;
const BAD_GATEWAY: ContentfulStatusCode = 502;
const CREATED: ContentfulStatusCode = 201;
const OK: ContentfulStatusCode = 200;
const NO_CONTENT = 204;

/**
 * How an upstream refusal is reported to the CMS.
 *
 * A 5xx from the git host becomes 502 rather than being passed through: the CMS should retry a
 * bad gateway and must not retry its own 500. Anything else is passed through, because "you asked
 * for something that is not there" reads the same from either end.
 */
const STATUS_FROM_UPSTREAM: Readonly<Record<number, ContentfulStatusCode>> = {
  [NOT_FOUND]: NOT_FOUND,
  [FORBIDDEN]: FORBIDDEN,
  [CONFLICT]: CONFLICT,
  [UNPROCESSABLE]: CONFLICT,
};

const saveDraftSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  deletions: z.array(z.string().min(1)).default([]),
  message: z.string().optional(),
});

const submitSchema = z.object({
  branch: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
});

export interface CmsRoutesOptions {
  readonly reader: DocumentReader;
  readonly drafts: DraftService;
  readonly submissions: SubmissionService;
  readonly settings: CmsSettings;
  readonly allowMergeFromCms: boolean;
  readonly auth: ReturnType<typeof createAuthMiddleware>;
  /** Backs the readiness guard, which is what actually turns traffic away — see R10. */
  readonly tokens: InstallationTokenSource;
  /** Passed to the Decap adapter, which enumerates draft branches. See `cms/decap/context.ts`. */
  readonly client: GitHubClient;
}

interface Refusal {
  readonly status: ContentfulStatusCode;
  readonly body: Record<string, unknown>;
  readonly decision: 'refused' | 'upstream-error';
  readonly reason: string;
  readonly upstreamStatus?: number;
}

/**
 * Maps a thrown error onto the response and the audit decision, or `undefined` to rethrow.
 *
 * Refusals and absences are answered distinctly and on purpose: an operator reviewing the audit
 * log needs "someone asked for something forbidden" and "someone asked for something absent" to be
 * different signals, which is the same reason `routes/documents.ts` never answers 404 for a policy
 * refusal.
 */
function refusalFor(error: unknown): Refusal | undefined {
  if (error instanceof CmsPolicyError || error instanceof EndpointPolicyError) {
    return {
      status: FORBIDDEN,
      body: { error: 'forbidden', reason: error.reason, message: error.message },
      decision: 'refused',
      reason: error.reason,
    };
  }
  if (error instanceof DocumentMissingError) {
    return {
      status: NOT_FOUND,
      body: { error: 'not_found', message: error.message },
      decision: 'refused',
      reason: 'not-found',
    };
  }
  if (error instanceof GitHubError) {
    return {
      status: STATUS_FROM_UPSTREAM[error.status] ?? BAD_GATEWAY,
      body: { error: 'upstream_error', message: error.message },
      decision: 'upstream-error',
      reason: 'git-host-refused',
      upstreamStatus: error.status,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: BAD_REQUEST,
      body: { error: 'invalid_request', issues: error.issues.map((issue) => issue.message) },
      decision: 'refused',
      reason: 'invalid-request',
    };
  }
  // `c.req.json()` throws this on a body that is not JSON at all, before zod ever sees it. Without
  // this row it fell through to the rethrow and became a 500 — the client's mistake reported as
  // ours, and with no audit record naming who sent it.
  if (error instanceof SyntaxError) {
    return {
      status: BAD_REQUEST,
      body: { error: 'invalid_json', message: 'The request body is not valid JSON.' },
      decision: 'refused',
      reason: 'invalid-json',
    };
  }
  return undefined;
}

type CmsHandler = (c: Context<AppEnv>) => Promise<Response>;

type RefusalMapper = (error: unknown) => Refusal | undefined;

/**
 * The same refusals, in the body Decap can show an author.
 *
 * Decap's proxy client throws `APIError(json.error, status)` and puts `error` in front of the
 * person editing, so `error` has to carry the sentence rather than the machine code. The REST
 * routes keep their own shape — a scripted client wants the code in a stable field, and
 * `scripts/check/verify-gateway.ts` asserts on it — which is why this is a second mapper rather
 * than a change to the first.
 *
 * @param error - Whatever the action threw.
 * @returns The response and audit decision, or `undefined` to rethrow.
 */
function proxyRefusalFor(error: unknown): Refusal | undefined {
  if (error instanceof UnsupportedActionError) {
    return {
      status: BAD_REQUEST,
      body: { error: error.message, reason: 'unsupported-action' },
      decision: 'refused',
      reason: 'unsupported-action',
    };
  }
  if (error instanceof DraftMissingError) {
    // Decap turns a 404 here into its own `EditorialWorkflowError`, which is what makes a finished
    // card leave the board instead of showing the author an error they cannot act on.
    return {
      status: NOT_FOUND,
      body: { error: error.message, reason: 'no-draft' },
      decision: 'refused',
      reason: 'no-draft',
    };
  }

  const refusal = refusalFor(error);
  if (refusal === undefined) {
    return undefined;
  }

  const message = typeof refusal.body['message'] === 'string' ? refusal.body['message'] : undefined;
  const issues = Array.isArray(refusal.body['issues'])
    ? (refusal.body['issues'] as string[]).join('; ')
    : undefined;

  return {
    ...refusal,
    body: { error: message ?? issues ?? refusal.reason, reason: refusal.reason },
  };
}

/**
 * Reads a wildcard route parameter.
 *
 * Hono types `param` as possibly absent even where the route could not have matched without it.
 * Falling back to the empty string rather than asserting keeps the fail-closed direction: every
 * policy that receives one refuses it, so a Hono change that made this genuinely absent would
 * produce a 403 rather than a path built from `undefined`.
 */
function routeParam(c: Context<AppEnv>, name: string): string {
  return c.req.param(name) ?? '';
}

/**
 * Wraps a handler so that it always produces an audit record, and refusals become their statuses.
 *
 * This is a wrapper rather than middleware for a mechanical reason worth writing down: Hono's
 * `compose` catches a thrown error at the frame that threw and hands it straight to `onError`, so
 * a `try`/`catch` around `await next()` in an outer middleware never sees it. Audit and error
 * mapping have to live where the error is raised, or a refusal gets logged as a success.
 *
 * @param handler - The route body, which may throw a policy or upstream error.
 * @returns A handler that records the outcome and never leaks an unmapped error (R9).
 */
function handle(handler: CmsHandler, mapRefusal: RefusalMapper = refusalFor): CmsHandler {
  return async (c) => {
    const startedAt = c.get('startedAt');
    const identity = c.get('identity');
    // Read after the handler has run, never before: the proxy route only learns which action it is
    // serving once it has parsed the body, and a snapshot taken here would always be undefined.
    const base = (): Omit<AuditRecord, 'decision' | 'durationMs'> => ({
      subject: identity.subject,
      email: identity.email,
      method: c.req.method,
      path: c.req.path,
      action: c.get('decapAction'),
    });

    try {
      const response = await handler(c);
      recordAudit(c.get('logger'), {
        ...base(),
        decision: 'allowed',
        upstreamStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const refusal = mapRefusal(error);
      if (refusal === undefined) {
        // Still a decision about this request, so it still gets a record (R9). Without this, the
        // failures nobody anticipated — the ones most worth reading about later — were the only
        // ones that produced no audit line, leaving just the app-level error log with no subject,
        // path or duration attached.
        recordAudit(c.get('logger'), {
          ...base(),
          decision: 'error',
          reason: 'unhandled',
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      recordAudit(c.get('logger'), {
        ...base(),
        decision: refusal.decision,
        reason: refusal.reason,
        upstreamStatus: refusal.upstreamStatus,
        durationMs: Date.now() - startedAt,
      });
      return c.json(refusal.body, refusal.status);
    }
  };
}

function registerReadRoutes(app: Hono<AppEnv>, options: CmsRoutesOptions): void {
  app.get(
    '/config',
    handle((c) =>
      Promise.resolve(
        c.json({
          repository: options.settings.repository,
          defaultBranch: options.settings.defaultBranch,
          branchPrefix: options.settings.branchPrefix,
          pathPrefixes: options.settings.pathPrefixes,
          permittedExtensions: PERMITTED_EXTENSIONS,
          allowMergeFromCms: options.allowMergeFromCms,
        }),
      ),
    ),
  );

  // Answered from the verified token, never from the git host. With one App credential, asking
  // GitHub who is calling returns the App — the opposite of what R6 needs to record.
  app.get(
    '/identity',
    handle((c) => Promise.resolve(c.json(c.get('identity')))),
  );

  app.get(
    '/documents',
    handle(async (c) => c.json({ documents: await options.reader.list(c.req.query('branch')) })),
  );

  app.get(
    '/documents/:path{.+}',
    handle(async (c) =>
      c.json(await options.reader.read(routeParam(c, 'path'), c.req.query('branch'))),
    ),
  );
}

function registerDraftRoutes(app: Hono<AppEnv>, options: CmsRoutesOptions): void {
  app.put(
    '/drafts/:branch{.+}',
    handle(async (c) => {
      const request = saveDraftSchema.parse(await c.req.json());
      const saved = await options.drafts.save(
        { branch: routeParam(c, 'branch'), ...request },
        c.get('identity'),
      );
      return c.json(saved, saved.created ? CREATED : OK);
    }),
  );

  app.delete(
    '/drafts/:branch{.+}',
    handle(async (c) => {
      await options.drafts.discard(routeParam(c, 'branch'));
      return c.body(null, NO_CONTENT);
    }),
  );
}

function registerSubmissionRoutes(app: Hono<AppEnv>, options: CmsRoutesOptions): void {
  app.get(
    '/submissions',
    handle(async (c) =>
      c.json({ submissions: await options.submissions.list(c.req.query('branch')) }),
    ),
  );

  app.get(
    '/submissions/:number{[0-9]+}',
    handle(async (c) => c.json(await options.submissions.read(Number(c.req.param('number'))))),
  );

  app.post(
    '/submissions',
    handle(async (c) => {
      const request = submitSchema.parse(await c.req.json());
      return c.json(await options.submissions.submit(request, c.get('identity')), CREATED);
    }),
  );

  app.post(
    '/submissions/:number{[0-9]+}/merge',
    handle(async (c) => c.json(await options.submissions.merge(Number(c.req.param('number'))))),
  );
}

/**
 * The Decap adapter (ADR 0014, ADR 0015).
 *
 * One endpoint carrying every editorial operation, because that is the protocol Decap speaks: its
 * `proxy` backend posts `{action, params}` to a single URL. It sits inside this sub-app rather
 * than beside it so that it inherits authentication and the credential guard — an adapter mounted
 * separately would be one refactor away from being reachable without a token.
 *
 * Nothing here reaches the git host directly. Every action goes through the same services the REST
 * routes use, so the path, branch and endpoint policies apply unchanged and a refusal still costs
 * no upstream call.
 */
function registerProxyRoute(app: Hono<AppEnv>, options: CmsRoutesOptions): void {
  app.post(
    '/proxy',
    handle(async (c) => {
      const request = proxyRequestSchema.parse(await c.req.json());
      // Recorded before the action runs, so a refusal is still attributable to what was asked.
      c.set('decapAction', request.action);

      const result = await dispatch(request, {
        reader: options.reader,
        drafts: options.drafts,
        submissions: options.submissions,
        settings: options.settings,
        client: options.client,
        identity: c.get('identity'),
      });

      return c.json(result ?? null);
    }, proxyRefusalFor),
  );
}

/**
 * The editorial surface (requirements.md R1, R3–R7, R9).
 *
 * Authentication is mounted for the whole sub-app rather than per handler, so a route added later
 * cannot be added unauthenticated by omission — the failure mode of per-handler auth is that
 * forgetting it looks exactly like not needing it.
 *
 * @param options - The services, the CMS settings, and the auth middleware.
 * @returns A Hono app to mount at `/v1/cms`.
 */
export function createCmsRoutes(options: CmsRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', options.auth);
  // After authentication on purpose: an anonymous caller gets 401 and learns nothing about the
  // credential's state.
  app.use('*', createCredentialGuard({ tokens: options.tokens }));

  registerReadRoutes(app, options);
  registerDraftRoutes(app, options);
  registerSubmissionRoutes(app, options);
  registerProxyRoute(app, options);

  return app;
}

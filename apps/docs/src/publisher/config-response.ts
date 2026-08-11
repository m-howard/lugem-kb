const NOT_FOUND = 404;
const JSON_MEDIA_TYPE = 'application/json';

/**
 * What the origin serving this page said when asked how to sign an author in.
 *
 * - `configured` — the gateway answered; the editor can start.
 * - `unconfigured` — the gateway is there, `/v1/cms/*` is not. No amount of reloading mounts it.
 * - `unreachable` — the gateway answered badly. Possibly transient.
 * - `not-the-gateway` — something that is not the gateway answered, and answered with a page.
 */
export type ConfigOutcome = 'configured' | 'not-the-gateway' | 'unconfigured' | 'unreachable';

/**
 * Decides which of those four this response is, before anyone tries to parse it.
 *
 * The one that has to be caught early is `not-the-gateway`, because it is the only one that
 * *looks* like success: the Docusaurus dev server answers every unknown path with the site's HTML
 * and a 200, so `/v1/publisher/config` comes back as a page. Parsing it throws
 * `Unexpected token '<'`, which is a true statement about a string and tells an author nothing
 * about what they should do instead — open the site on the origin the gateway serves.
 *
 * Content type first, status second, deliberately. A 404 from the gateway is JSON (`routes/
 * api-not-found.ts` exists so that `/v1/*` never falls through to the site) and means the CMS is
 * switched off, while a 404 page from a static host means nobody is home. Same status, different
 * answer, and only the media type separates them.
 *
 * @param response - The reply to `/v1/publisher/config`, unread — this looks at headers only.
 * @returns Which kind of answer it is.
 */
export function classifyConfigResponse(response: Response): ConfigOutcome {
  if (!(response.headers.get('content-type') ?? '').includes(JSON_MEDIA_TYPE)) {
    return 'not-the-gateway';
  }
  if (response.status === NOT_FOUND) {
    return 'unconfigured';
  }
  return response.ok ? 'configured' : 'unreachable';
}

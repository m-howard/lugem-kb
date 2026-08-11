import { describe, expect, it } from 'vitest';

import { classifyConfigResponse } from './config-response';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

describe('classifyConfigResponse', () => {
  it('accepts the gateway sign-in configuration', () => {
    const response = new Response('{"authMode":"bearer"}', { headers: JSON_HEADERS });

    expect(classifyConfigResponse(response)).toBe('configured');
  });

  // The gateway's own 404 is JSON, because `/v1/*` terminates rather than falling through to the
  // site. That is what makes "switched off" distinguishable from "nobody is home".
  it('reads a JSON 404 as a deployment without the CMS', () => {
    const response = new Response('{"reason":"not-found"}', {
      status: 404,
      headers: JSON_HEADERS,
    });

    expect(classifyConfigResponse(response)).toBe('unconfigured');
  });

  // The case this function exists for: the Docusaurus dev server answers every unknown path with
  // the site's HTML and a 200, so the failure arrives dressed as success.
  it('rejects a page served with a 200, rather than parsing it', () => {
    const response = new Response('<!DOCTYPE html><html lang="en"></html>', {
      headers: HTML_HEADERS,
    });

    expect(classifyConfigResponse(response)).toBe('not-the-gateway');
  });

  it('rejects a static host 404 page, which is not the same as a configured-off gateway', () => {
    const response = new Response('<!DOCTYPE html><html lang="en"></html>', {
      status: 404,
      headers: HTML_HEADERS,
    });

    expect(classifyConfigResponse(response)).toBe('not-the-gateway');
  });

  it('treats a gateway error as possibly transient', () => {
    const response = new Response('{"reason":"internal"}', { status: 500, headers: JSON_HEADERS });

    expect(classifyConfigResponse(response)).toBe('unreachable');
  });

  // A response carrying no content type at all is nothing this page can parse either.
  it('rejects an answer that does not say what it is', () => {
    expect(classifyConfigResponse(new Response(null))).toBe('not-the-gateway');
  });
});

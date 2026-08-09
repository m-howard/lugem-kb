/**
 * The URL a `fetch` call was made with, whatever shape the caller passed.
 *
 * `String(input)` would stringify a `Request` as `[object Object]`, which turns a test asserting
 * on the URL into one asserting on nothing at all.
 *
 * @param input - The first argument to `fetch`.
 * @returns The URL as a string.
 */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

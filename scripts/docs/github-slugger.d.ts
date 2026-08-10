/**
 * Types for `github-slugger`, which ships none and has no DefinitelyTyped package.
 *
 * Depended on directly, at the version Docusaurus resolves, because it *is* the slugger that
 * produces the anchors the published site carries — `@docusaurus/utils`' `createSlugger` is a
 * three-line wrapper around this class. A second implementation of the same rules in
 * `scripts/docs/links.ts` would only be a second thing to keep in step, and the gate that fails an
 * author's valid link is worse than no gate.
 */
declare module 'github-slugger' {
  export default class GithubSlugger {
    /**
     * Slugifies one heading and remembers it, appending `-1`, `-2`, … to a slug already produced.
     *
     * @param value - The heading's plain text.
     * @param maintainCase - Keep the heading's casing instead of lowercasing it.
     * @returns The anchor, unique across every call since the last {@link reset}.
     */
    slug(value: string, maintainCase?: boolean): string;
    /** Forgets every slug produced so far. */
    reset(): void;
  }
}

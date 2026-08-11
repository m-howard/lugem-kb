#!/usr/bin/env bun
/**
 * Bundles the `/publisher` page: `apps/docs/src/publisher/main.ts` →
 * `apps/docs/static/publisher/publisher.js`.
 *
 * Docusaurus copies `static/` verbatim and does not compile it, so the editor's entry point cannot
 * be a bare `.ts` module — something has to turn it into one browser-ready file first. That is this
 * script, wired as the `prebuild` and `prestart` hooks of `apps/docs/package.json` so no one has to
 * remember to run it.
 *
 * Decap is bundled *into* the output rather than loaded beside it. Its published dist file
 * externalises React as a peer dependency, so behind a plain script tag it reaches for globals
 * nothing on the page defines; inlining it lets the bundler satisfy those imports.
 *
 * The output is gitignored (`.prettierignore` and `eslint.config.mjs` skip it too) — it is a
 * vendored bundle plus a minified shim, and linting either says nothing about code anyone here
 * writes. This script is not: it lives under `scripts/build/`, which the ignore files deliberately
 * un-ignore.
 *
 * Usage:
 *   bun run scripts/build/build-publisher.ts
 *   ... --no-minify   # readable output, for debugging the sign-in shim
 */
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY_POINT = join(REPO_ROOT, 'apps/docs/src/publisher/main.ts');
const OUTPUT_DIRECTORY = join(REPO_ROOT, 'apps/docs/static/publisher');
const OUTPUT_FILE = join(OUTPUT_DIRECTORY, 'publisher.js');
const EXIT_FAILURE = 1;

/**
 * Decap reads this at module scope to pick its development or production build. Bun's browser
 * target leaves `process.env` alone, so without the substitution the bundle references a `process`
 * global that does not exist in a browser and the editor dies before it renders.
 */
const BROWSER_DEFINES: Record<string, string> = {
  'process.env.NODE_ENV': '"production"',
};

async function buildPublisher(): Promise<void> {
  // Removed rather than overwritten: a failed build that leaves last run's bundle in place is the
  // worst outcome here, because the page still loads and the change simply is not in it.
  await rm(OUTPUT_FILE, { force: true });

  const result = await Bun.build({
    entrypoints: [ENTRY_POINT],
    outdir: OUTPUT_DIRECTORY,
    naming: 'publisher.[ext]',
    target: 'browser',
    format: 'esm',
    minify: !process.argv.includes('--no-minify'),
    define: BROWSER_DEFINES,
  });

  if (!result.success) {
    // `message` rather than the log object: Bun's build logs are `BuildMessage`s, and stringifying
    // one gives `[object Object]` — which is exactly the unactionable failure this branch exists
    // to avoid.
    const detail = result.logs.map((log) => log.message).join('\n');
    throw new Error(`Could not bundle the /publisher page:\n${detail}`);
  }

  // Belt and braces. `success` has been true for a build that wrote nothing when every entrypoint
  // resolved to an empty module, and a silently absent `publisher.js` leaves an author looking at
  // "Signing you in…" with a 404 in a console they will not open.
  const written = await Bun.file(OUTPUT_FILE).exists();
  if (!written) {
    throw new Error(`The bundler reported success but wrote no ${OUTPUT_FILE}.`);
  }

  const bytes = Bun.file(OUTPUT_FILE).size;
  console.log(
    `Bundled the /publisher page → ${OUTPUT_FILE} (${String(Math.round(bytes / 1024))} kB)`,
  );
}

try {
  await buildPublisher();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
}

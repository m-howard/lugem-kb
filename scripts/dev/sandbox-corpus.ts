import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { MEDIA_EXTENSIONS } from '../../apps/gateway/src/git/media-policy';
import { type SeedFile } from '../../apps/gateway/tests/helpers/git-repo';
import { findMarkdownFiles } from '../docs/corpus-files';

/**
 * The repository's own `docs/` tree, as a corpus the sandbox git host can be seeded with.
 *
 * Real content rather than two fixture pages, because the frontmatter this repository actually
 * writes — `title`, `owner`, `last_reviewed`, `sidebar_position` — is exactly what the editor's
 * collection is configured for (`apps/docs/src/admin/main.ts`). Seeding from anything else would
 * mean every page opened in the sandbox showed a schema mismatch that production would not have.
 *
 * Images are included so the media library has something in it. They are read as raw bytes and
 * kept base64 throughout: that is how the gateway sends and reads a blob, and decoding a PNG to a
 * string in between would corrupt it.
 */

/** Where the corpus lives, relative to the repository root. */
export const CORPUS_ROOT = 'docs';

/** Published as a static directory by `apps/docs`, and the folder uploads are confined to. */
export const MEDIA_ROOT = 'docs/assets/media';

/**
 * Reads every image beneath a directory, or nothing when the directory does not exist.
 *
 * Absence is normal: a fresh checkout has an empty media folder, and the sandbox should start with
 * a bare media library rather than fail to boot.
 */
async function findImages(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => MEDIA_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Loads the corpus the sandbox repository starts from.
 *
 * @param root - Repository root to read `docs/` beneath. Defaults to the working directory.
 * @returns Repository-relative paths mapped to their content.
 */
export async function loadSandboxCorpus(root = '.'): Promise<Record<string, SeedFile>> {
  const corpus: Record<string, SeedFile> = {};

  for (const page of await findMarkdownFiles(join(root, CORPUS_ROOT))) {
    const path = `${CORPUS_ROOT}/${page}`;
    corpus[path] = { content: await readFile(join(root, path), 'utf8') };
  }

  for (const image of await findImages(join(root, MEDIA_ROOT))) {
    const path = relative(root, image).split(sep).join('/');
    corpus[path] = { content: (await readFile(image)).toString('base64'), encoding: 'base64' };
  }

  return corpus;
}

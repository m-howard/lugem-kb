import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** What the corpus is allowed to contain, mirroring the gateway's `PERMITTED_EXTENSIONS`. */
export const MARKDOWN_EXTENSIONS = ['.md', '.mdx'];

/**
 * Walks a documentation tree, returning POSIX-style paths relative to it.
 *
 * Shared by the corpus sync and the content quality gates so the two never disagree about what the
 * corpus *is*. A page the checker skipped but the sync uploaded would be an unvalidated page in the
 * index, which is the failure worth designing out.
 *
 * @param root - Directory to walk, e.g. `docs`.
 * @param base - Internal; the directory paths are made relative to. Defaults to `root`.
 * @returns Every markdown file beneath `root`, sorted.
 *
 * @example
 * ```ts
 * await findMarkdownFiles('docs');
 * // → ['adr/0001-bun-workspace-monorepo.md', 'asking-questions.md', ...]
 * ```
 */
export async function findMarkdownFiles(root: string, base = root): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(full, base)));
    } else if (MARKDOWN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(relative(base, full).split(sep).join('/'));
    }
  }

  return files.sort();
}

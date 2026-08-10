import { type ImplementationEntry } from './protocol';
import { normalisePrefix } from '../../kb/key-policy';
import { type DocumentContent, type DocumentReader } from '../documents';

/** How Decap narrows a collection listing: a folder, optionally an extension and a nesting depth. */
export interface FolderQuery {
  readonly folder: string;
  readonly extension?: string | undefined;
  readonly depth?: number | undefined;
}

/**
 * Decides whether one repository path belongs to a collection.
 *
 * Pure, so the whole of Decap's folder/extension/depth semantics can be asserted as a table
 * instead of being discovered against a live repository. The path policy has already run by the
 * time this is consulted — this narrows a permitted set, it does not authorise anything.
 *
 * @param path - Repository-relative path, e.g. `docs/guides/leave-policy.md`.
 * @param query - The collection's folder, and optionally its extension and depth.
 * @returns Whether the path is in the collection.
 *
 * @example
 * ```ts
 * selectsPath('docs/guides/leave.md', { folder: 'docs/guides', extension: 'md', depth: 1 });
 * // → true
 * ```
 */
export function selectsPath(path: string, query: FolderQuery): boolean {
  const folder = normalisePrefix(query.folder);
  if (folder !== '' && !path.startsWith(folder)) {
    return false;
  }

  const relative = path.slice(folder.length);
  if (relative === '') {
    return false;
  }

  if (query.extension !== undefined && query.extension !== '') {
    const suffix = query.extension.startsWith('.') ? query.extension : `.${query.extension}`;
    if (!path.toLowerCase().endsWith(suffix.toLowerCase())) {
      return false;
    }
  }

  return query.depth === undefined || relative.split('/').length <= query.depth;
}

/**
 * Maps a document onto the shape Decap's backend contract expects.
 *
 * `id` carries the blob sha. Decap treats it as opaque, and it is the only identifier here that
 * changes when the content does.
 *
 * @param document - A document read from the corpus.
 * @returns The entry.
 */
export function toImplementationEntry(document: DocumentContent): ImplementationEntry {
  return { data: document.content, file: { path: document.path, id: document.sha } };
}

/**
 * Lists a collection, with content.
 *
 * @param reader - The corpus reader.
 * @param query - The collection's folder, extension and depth, plus the branch to read.
 * @returns Every entry in the collection.
 */
export async function entriesByFolder(
  reader: DocumentReader,
  query: FolderQuery & { readonly branch?: string | undefined },
): Promise<readonly ImplementationEntry[]> {
  const documents = await reader.listContent((path) => selectsPath(path, query), query.branch);
  return documents.map(toImplementationEntry);
}

/**
 * Reads a named set of files.
 *
 * A path that is absent is skipped rather than failing the batch: Decap asks for the files it
 * last saw, and a page deleted since then is a normal race, not an error worth blanking the
 * collection over.
 *
 * @param reader - The corpus reader.
 * @param query - The paths to read and the branch to read them from.
 * @returns The entries that exist.
 */
export async function entriesByFiles(
  reader: DocumentReader,
  query: {
    readonly files: readonly { readonly path: string }[];
    readonly branch?: string | undefined;
  },
): Promise<readonly ImplementationEntry[]> {
  const wanted = new Set(query.files.map((file) => file.path));
  const documents = await reader.listContent((path) => wanted.has(path), query.branch);
  return documents.map(toImplementationEntry);
}

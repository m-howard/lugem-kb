import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type RepoState } from '../../apps/gateway/tests/helpers/git-repo';

/**
 * Where the sandbox repository lives between runs.
 *
 * Drafts have to survive `Ctrl-C`. A page half-written on Monday and finished on Tuesday is the
 * normal way documentation gets written, and a sandbox that forgot it every restart would be a
 * demo rather than somewhere to work.
 *
 * The file is gitignored and disposable: `--reset` deletes it, and so can you.
 */

export const SANDBOX_STATE_PATH = '.lugem-local/cms-sandbox.json';

const JSON_INDENT = 2;

/** How long to wait for more changes before writing. One save is several mutating requests. */
const WRITE_DEBOUNCE_MS = 250;

export interface SandboxStore {
  /** The stored repository, or `undefined` when there is nothing to restore. */
  load(): Promise<RepoState | undefined>;
  /** Queues a write. Repeated calls within the debounce window collapse into one. */
  save(state: () => RepoState): void;
  /** Writes anything still queued. Call before exit. */
  flush(): Promise<void>;
  discard(): Promise<void>;
}

/**
 * Builds the sandbox's persistence.
 *
 * @param path - Where to keep the state. Defaults to {@link SANDBOX_STATE_PATH}.
 * @returns Load, save and discard operations.
 */
export function createSandboxStore(path: string = SANDBOX_STATE_PATH): SandboxStore {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => RepoState) | undefined;
  let writing: Promise<void> = Promise.resolve();

  async function write(state: RepoState): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // Through a temporary file so a crash mid-write cannot leave unparseable JSON behind — the
    // one failure mode that would lose every draft rather than the last one.
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(state, undefined, JSON_INDENT), 'utf8');
    await rename(temporary, path);
  }

  function drain(): void {
    const next = pending;
    pending = undefined;
    timer = undefined;
    if (next !== undefined) {
      writing = writing.then(() => write(next())).catch(() => undefined);
    }
  }

  return {
    async load(): Promise<RepoState | undefined> {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as RepoState;
      } catch {
        return undefined;
      }
    },

    save(state: () => RepoState): void {
      pending = state;
      timer ??= setTimeout(drain, WRITE_DEBOUNCE_MS);
    },

    async flush(): Promise<void> {
      if (timer !== undefined) {
        clearTimeout(timer);
        drain();
      }
      await writing;
    },

    async discard(): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

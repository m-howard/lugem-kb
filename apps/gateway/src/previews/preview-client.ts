import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export interface PreviewObject {
  /** The key that answered, so the caller can derive a content type from the real extension. */
  readonly key: string;
  readonly body: Uint8Array;
}

export interface PreviewClientOptions {
  readonly s3: S3Client;
  readonly bucket: string;
}

/**
 * Read-only view of the pull request preview bucket (requirements.md R12).
 *
 * Separate from `kb/corpus-client.ts` and from a separate bucket, which is the point rather than an
 * accident: R21 says preview builds are never ingested, and a bucket the knowledge base has never
 * heard of makes that true by construction instead of by prefix discipline. The task role can read
 * `pr-*` here and nothing else.
 *
 * The S3 client is injected so the HTTP surface can be tested without credentials.
 */
export class PreviewClient {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(options: PreviewClientOptions) {
    this.#s3 = options.s3;
    this.#bucket = options.bucket;
  }

  /**
   * Fetches the first key that exists.
   *
   * Takes the candidate list rather than one key because a Docusaurus route and the object backing
   * it are not the same string — `resolvePreviewRequest` works out both spellings, and a miss on
   * the first is expected rather than exceptional.
   *
   * @param keys - Candidate keys, in the order they should be tried.
   * @returns The first object found, or `undefined` if none of the keys exist.
   */
  async getFirst(keys: readonly string[]): Promise<PreviewObject | undefined> {
    for (const key of keys) {
      const body = await this.#read(key);
      if (body !== undefined) {
        return { key, body };
      }
    }
    return undefined;
  }

  async #read(key: string): Promise<Uint8Array | undefined> {
    const response = await this.#s3
      .send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }))
      .catch((error: unknown) => {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      });

    // A preview holds binary assets — fonts and images — so the body is read as bytes rather than
    // as a string. Decoding a woff2 as UTF-8 and re-encoding it corrupts it silently.
    return response?.Body === undefined ? undefined : await response.Body.transformToByteArray();
  }
}

/**
 * S3 spells "no such object" three ways depending on whether the caller may list the bucket:
 * `NoSuchKey`, `NotFound`, and `AccessDenied` for a `GetObject` on a key that is not there when
 * the principal has no `s3:ListBucket`. All three mean the same thing to a reader.
 */
function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'NoSuchKey' || error.name === 'NotFound' || error.name === 'AccessDenied';
}

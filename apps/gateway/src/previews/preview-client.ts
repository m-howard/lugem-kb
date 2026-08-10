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
 * The preview bucket refused the read.
 *
 * Distinct from a miss on purpose. `AccessDenied` on a `GetObject` is what a wrong task role, a
 * bucket policy that lost its statement, or an encryption key the task cannot use all look like —
 * and every one of those is an operator's problem with the deployment, not an author's pull
 * request that has not finished building. Folded into the 404 they are invisible: every preview
 * says "may not have finished yet" and nothing is ever logged.
 */
export class PreviewAccessError extends Error {
  constructor(bucket: string, key: string, cause: unknown) {
    super(`The preview bucket ${bucket} refused a read of ${key}.`);
    this.name = 'PreviewAccessError';
    this.cause = cause;
  }
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
   * @throws {PreviewAccessError} When S3 refuses the read rather than reporting it missing.
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
        if (isRefused(error)) {
          throw new PreviewAccessError(this.#bucket, key, error);
        }
        throw error;
      });

    // A preview holds binary assets — fonts and images — so the body is read as bytes rather than
    // as a string. Decoding a woff2 as UTF-8 and re-encoding it corrupts it silently.
    return response?.Body === undefined ? undefined : await response.Body.transformToByteArray();
  }
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return undefined;
  }
  return typeof error.name === 'string' ? error.name : undefined;
}

/**
 * S3 spells "no such object" two ways: `NoSuchKey` from `GetObject`, `NotFound` from `HeadObject`.
 *
 * It spells it a third way — `AccessDenied` — when the caller has no `s3:ListBucket` on the bucket,
 * because a principal that cannot enumerate keys is not told which ones are absent. That third
 * spelling is deliberately *not* treated as a miss here. The task role holds `s3:ListBucket` on the
 * preview bucket for exactly this reason (see `taskPolicyDocument` in
 * `infra/pulumi/src/components/gateway-service.ts`), so a real miss arrives as `NoSuchKey` and an
 * `AccessDenied` means what it says.
 */
function isMissing(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NoSuchKey' || name === 'NotFound';
}

/**
 * Authorization failures, as the SDK names them.
 *
 * Only these are renamed; anything else — a KMS refusal, a timeout, a 503 — already propagates
 * untouched to the error handler. The wrapper exists to make the one failure that used to be
 * silent say who has to fix it.
 */
function isRefused(error: unknown): boolean {
  const name = errorName(error);
  return name === 'AccessDenied' || name === 'AllAccessDisabled';
}

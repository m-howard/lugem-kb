import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';

import { normalisePrefix, resolveDocumentKey } from './key-policy';

/** S3 caps a single ListObjectsV2 page at 1000 keys; asking for more is silently clamped. */
const MAX_KEYS_PER_PAGE = 1000;

export interface DocumentSummary {
  /** Path relative to the corpus prefix — what a client passes back to fetch the document. */
  readonly path: string;
  readonly size: number;
  readonly lastModified: string | undefined;
}

export interface DocumentContent {
  readonly path: string;
  readonly body: string;
  readonly lastModified: string | undefined;
}

export interface CorpusClientOptions {
  readonly s3: S3Client;
  readonly bucket: string;
  readonly prefix: string;
}

/**
 * Thrown when a requested document is absent, so routes can answer 404 without inspecting
 * AWS SDK error shapes.
 */
export class DocumentNotFoundError extends Error {
  constructor(path: string) {
    super(`No document at ${path}`);
    this.name = 'DocumentNotFoundError';
  }
}

/** Thrown when a path violates key policy, carrying the reason so the route can log it at warn. */
export class DocumentPolicyError extends Error {
  public readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DocumentPolicyError';
    this.reason = reason;
  }
}

/**
 * Read-only view of the markdown corpus in S3.
 *
 * The S3 client is injected rather than constructed here so the HTTP surface can be tested
 * without network access or credentials.
 */
export class CorpusClient {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(options: CorpusClientOptions) {
    this.#s3 = options.s3;
    this.#bucket = options.bucket;
    this.#prefix = normalisePrefix(options.prefix);
  }

  /**
   * Confirms the corpus bucket is reachable and readable. Backs `/readyz`, never `/healthz`.
   *
   * @returns `true` when the bucket answers; throws whatever the SDK threw otherwise.
   */
  async checkReachable(): Promise<boolean> {
    await this.#s3.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    return true;
  }

  /**
   * Lists documents under the corpus prefix.
   *
   * @param options - `continuationToken` resumes a previous page.
   * @returns One page of summaries plus a token when more remain.
   */
  async list(
    options: { readonly continuationToken?: string } = {},
  ): Promise<{ documents: DocumentSummary[]; nextToken: string | undefined }> {
    const response = await this.#s3.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: this.#prefix,
        MaxKeys: MAX_KEYS_PER_PAGE,
        ...(options.continuationToken === undefined
          ? {}
          : { ContinuationToken: options.continuationToken }),
      }),
    );

    const documents = (response.Contents ?? [])
      .filter((object) => object.Key !== undefined && object.Key !== this.#prefix)
      .map((object) => ({
        path: (object.Key ?? '').slice(this.#prefix.length),
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString(),
      }))
      .filter((document) => document.path !== '');

    return { documents, nextToken: response.NextContinuationToken };
  }

  /**
   * Fetches one document, refusing the path before any S3 call if it violates key policy.
   *
   * @param requestedPath - Path relative to the corpus prefix.
   * @param options - `maxBytes` requests only the first N bytes, for callers that need the
   *   frontmatter rather than the page. The body is then truncated, not the whole document.
   * @returns The document body and metadata.
   * @throws {DocumentPolicyError} When the path is not permitted.
   * @throws {DocumentNotFoundError} When no object exists at the resolved key.
   */
  async get(
    requestedPath: string,
    options: { readonly maxBytes?: number } = {},
  ): Promise<DocumentContent> {
    const resolved = resolveDocumentKey(requestedPath, { prefix: this.#prefix });
    if (!resolved.ok) {
      throw new DocumentPolicyError(resolved.reason, resolved.message);
    }

    const response = await this.#s3
      .send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: resolved.key,
          ...(options.maxBytes === undefined
            ? {}
            : { Range: `bytes=0-${String(options.maxBytes - 1)}` }),
        }),
      )
      .catch((error: unknown) => {
        if (isNoSuchKey(error)) {
          throw new DocumentNotFoundError(requestedPath);
        }
        throw error;
      });

    if (response.Body === undefined) {
      throw new DocumentNotFoundError(requestedPath);
    }

    return {
      path: requestedPath,
      body: await response.Body.transformToString(),
      lastModified: response.LastModified?.toISOString(),
    };
  }
}

function isNoSuchKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NoSuchKey' || error.name === 'NotFound')
  );
}

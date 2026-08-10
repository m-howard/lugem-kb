import {
  type BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { type BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * In-memory stand-ins for the two AWS clients the gateway talks to.
 *
 * Deliberately hand-written rather than `aws-sdk-client-mock`: the fakes are small, and a
 * hand-written one can model the behaviour that matters here — a missing key raising `NoSuchKey`,
 * a bucket being unreachable — which is what the routes actually branch on.
 */

export interface FakeCorpusOptions {
  /** Object keys mapped to their contents. Keys are full S3 keys, including the prefix. */
  readonly objects: Readonly<Record<string, string>>;
  /** When true, every call rejects — used to exercise the readiness path. */
  readonly unreachable?: boolean;
}

class NoSuchKeyError extends Error {
  constructor() {
    super('The specified key does not exist.');
    this.name = 'NoSuchKey';
  }
}

/**
 * Builds a fake S3 client backed by an object map.
 *
 * @param options - Objects to serve, and whether the bucket should appear unreachable.
 * @returns Something structurally usable as an `S3Client`.
 */
export function fakeS3Client(options: FakeCorpusOptions): S3Client {
  const send = (command: unknown): Promise<unknown> => {
    if (options.unreachable === true) {
      return Promise.reject(new Error('connection refused'));
    }

    if (command instanceof HeadBucketCommand) {
      return Promise.resolve({});
    }

    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? '';
      return Promise.resolve({
        Contents: Object.entries(options.objects)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, body]) => ({
            Key: key,
            Size: body.length,
            LastModified: new Date('2026-08-01T00:00:00.000Z'),
          })),
      });
    }

    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? '';
      const body = options.objects[key];
      if (body === undefined) {
        return Promise.reject(new NoSuchKeyError());
      }
      return Promise.resolve({
        // Both transforms, as the real SDK offers: the corpus reads text, the preview surface
        // reads bytes because a build holds fonts and images that a UTF-8 round trip would corrupt.
        Body: {
          transformToString: () => Promise.resolve(body),
          transformToByteArray: () => Promise.resolve(new TextEncoder().encode(body)),
        },
        LastModified: new Date('2026-08-01T00:00:00.000Z'),
      });
    }

    return Promise.reject(new Error(`Unexpected S3 command: ${String(command)}`));
  };

  return { send } as unknown as S3Client;
}

export interface FakeRetrievalResult {
  readonly text: string;
  readonly uri: string;
  readonly score: number;
}

/**
 * Builds a fake Bedrock agent runtime client returning fixed retrieval results.
 *
 * @param results - Results to return from every `Retrieve` call.
 * @returns Something structurally usable as a `BedrockAgentRuntimeClient`.
 */
export function fakeBedrockClient(
  results: readonly FakeRetrievalResult[],
): BedrockAgentRuntimeClient {
  const send = (command: unknown): Promise<unknown> => {
    if (!(command instanceof RetrieveCommand)) {
      return Promise.reject(new Error(`Unexpected Bedrock command: ${String(command)}`));
    }
    return Promise.resolve({
      retrievalResults: results.map((result) => ({
        content: { text: result.text },
        location: { s3Location: { uri: result.uri } },
        score: result.score,
      })),
    });
  };

  return { send } as unknown as BedrockAgentRuntimeClient;
}

export interface FakeAnswerOptions {
  /** Text deltas the model "writes", in order. */
  readonly chunks: readonly string[];
  /** Reject before streaming starts — models AccessDenied or a bad model ID. */
  readonly failBeforeStreaming?: boolean;
  /** Emit a throttling member after this many chunks — models a mid-stream failure. */
  readonly failAfterChunks?: number;
}

/**
 * Builds a fake Bedrock runtime client that streams fixed text.
 *
 * A separate client from {@link fakeBedrockClient}: retrieval and generation are two different
 * AWS services, and keeping the fakes apart is what lets a test assert that the no-coverage path
 * never reached the generation one. Like its siblings, this rejects any command it did not
 * expect, so a route touching an unintended API fails loudly rather than silently passing.
 *
 * @param options - The text to stream, and the failure to inject if any.
 * @returns Something structurally usable as a `BedrockRuntimeClient`.
 */
export function fakeBedrockRuntimeClient(options: FakeAnswerOptions): BedrockRuntimeClient {
  const send = (command: unknown): Promise<unknown> => {
    if (!(command instanceof ConverseStreamCommand)) {
      return Promise.reject(new Error(`Unexpected Bedrock runtime command: ${String(command)}`));
    }
    if (options.failBeforeStreaming === true) {
      return Promise.reject(new Error('AccessDeniedException on bedrock:InvokeModel'));
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* stream() {
      for (const [index, text] of options.chunks.entries()) {
        if (index === options.failAfterChunks) {
          yield { throttlingException: { message: 'too many tokens per minute' } };
          return;
        }
        yield { contentBlockDelta: { delta: { text } } };
      }
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage: { inputTokens: 1200, outputTokens: 42 } } };
    }

    return Promise.resolve({ stream: stream() });
  };

  return { send } as unknown as BedrockRuntimeClient;
}

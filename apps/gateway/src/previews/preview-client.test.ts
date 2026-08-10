import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { PreviewAccessError, PreviewClient } from './preview-client';

/** An error shaped the way the AWS SDK shapes one: the code is on `name`. */
function s3Error(name: string): Error {
  const error = new Error(`${name} on GetObject`);
  error.name = name;
  return error;
}

interface StubOptions {
  readonly objects?: Readonly<Record<string, string>>;
  /** Raised for any key not in `objects`, instead of `NoSuchKey`. */
  readonly failWith?: string;
}

function stubS3(options: StubOptions): S3Client {
  const send = (command: unknown): Promise<unknown> => {
    if (!(command instanceof GetObjectCommand)) {
      return Promise.reject(new Error('Unexpected command'));
    }
    const body = options.objects?.[command.input.Key ?? ''];
    if (body === undefined) {
      return Promise.reject(s3Error(options.failWith ?? 'NoSuchKey'));
    }
    return Promise.resolve({
      Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(body)) },
    });
  };

  return { send } as unknown as S3Client;
}

function client(options: StubOptions): PreviewClient {
  return new PreviewClient({ s3: stubS3(options), bucket: 'previews' });
}

describe('PreviewClient', () => {
  it('returns the first key that exists, with the key that answered', async () => {
    const found = await client({ objects: { 'pr-42/a/index.html': 'page' } }).getFirst([
      'pr-42/a/index.html',
      'pr-42/a',
    ]);

    expect(found?.key).toBe('pr-42/a/index.html');
    expect(new TextDecoder().decode(found?.body)).toBe('page');
  });

  it('tries the next candidate after a miss', async () => {
    const found = await client({ objects: { 'pr-42/a': 'file' } }).getFirst([
      'pr-42/a/index.html',
      'pr-42/a',
    ]);

    expect(found?.key).toBe('pr-42/a');
  });

  it.each([['NoSuchKey'], ['NotFound']])('reports %s as a miss', async (name) => {
    await expect(
      client({ failWith: name }).getFirst(['pr-42/index.html']),
    ).resolves.toBeUndefined();
  });

  /**
   * The distinction the whole class exists to keep. A task role missing `s3:GetObject`, a bucket
   * policy that lost a statement, an encryption key the task cannot use — all of them arrive here
   * as `AccessDenied`, and all of them are an operator's problem with a deployment. Answering 404
   * makes every one of them look like "the build has not finished yet" and logs nothing.
   */
  it.each([['AccessDenied'], ['AllAccessDisabled']])(
    'raises %s rather than reporting it missing',
    async (name) => {
      await expect(client({ failWith: name }).getFirst(['pr-42/index.html'])).rejects.toThrow(
        PreviewAccessError,
      );
    },
  );

  it('names the bucket and the key it was refused', async () => {
    await expect(
      client({ failWith: 'AccessDenied' }).getFirst(['pr-42/index.html']),
    ).rejects.toThrow('previews');
  });

  it('keeps the original error as the cause', async () => {
    const error = await client({ failWith: 'AccessDenied' })
      .getFirst(['pr-42/index.html'])
      .catch((caught: unknown) => caught);

    expect((error as PreviewAccessError).cause).toMatchObject({ name: 'AccessDenied' });
  });

  // A timeout or a 503 is neither a miss nor a refusal, and renaming it would lose what it says.
  it('passes any other failure through untouched', async () => {
    await expect(
      client({ failWith: 'TimeoutError' }).getFirst(['pr-42/index.html']),
    ).rejects.toThrow('TimeoutError on GetObject');
  });

  it('returns nothing for an empty candidate list', async () => {
    await expect(client({}).getFirst([])).resolves.toBeUndefined();
  });
});

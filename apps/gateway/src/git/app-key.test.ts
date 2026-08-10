import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';

import { createAppKeyLoader, toPkcs8 } from './app-key';

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:lugem-cms-app-abc123';

const KEY_PAIR = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS1_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs1', format: 'pem' });
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' });

/** A Secrets Manager stand-in that fails loudly on any command but the one expected. */
function fakeSecrets(secretString: string | undefined) {
  const send = vi.fn((command: { input: { SecretId?: string } }) => {
    if (command.input.SecretId !== SECRET_ARN) {
      throw new Error(`Unexpected secret ${String(command.input.SecretId)}`);
    }
    return Promise.resolve({ SecretString: secretString });
  });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

describe('toPkcs8', () => {
  // The PEM GitHub hands you when you create an App is PKCS#1. WebCrypto imports PKCS#8 only, and
  // the parse error names neither format — so this conversion is what lets an operator paste the
  // file they were given rather than discovering `openssl pkcs8` from a stack trace.
  it('converts the PKCS#1 key GitHub issues', () => {
    expect(PKCS1_PEM).toContain('BEGIN RSA PRIVATE KEY');

    const converted = toPkcs8(PKCS1_PEM);

    expect(converted).toContain('BEGIN PRIVATE KEY');
    expect(converted).toBe(PKCS8_PEM);
  });

  it('leaves a PKCS#8 key alone', () => {
    expect(toPkcs8(PKCS8_PEM)).toBe(PKCS8_PEM);
  });
});

describe('createAppKeyLoader', () => {
  it('imports the key held in Secrets Manager', async () => {
    const secrets = fakeSecrets(PKCS1_PEM);
    const load = createAppKeyLoader({ secretArn: SECRET_ARN, secrets: secrets.client });

    await expect(load()).resolves.toMatchObject({ type: 'private' });
  });

  it('reads the secret once, however many callers there are', async () => {
    const secrets = fakeSecrets(PKCS8_PEM);
    const load = createAppKeyLoader({ secretArn: SECRET_ARN, secrets: secrets.client });

    await Promise.all([load(), load()]);
    await load();

    expect(secrets.send).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure rather than caching it forever', async () => {
    const secrets = fakeSecrets(undefined);
    const load = createAppKeyLoader({ secretArn: SECRET_ARN, secrets: secrets.client });

    await expect(load()).rejects.toThrow(/empty/);
    await expect(load()).rejects.toThrow(/empty/);
    expect(secrets.send).toHaveBeenCalledTimes(2);
  });

  // The stack creates the secret empty on purpose, so this is the first thing an operator hits.
  // docs/corpus-repository.md step 4 is the fix, and the message points at it.
  it('says what to do when the secret has not been written yet', async () => {
    const secrets = fakeSecrets('   ');
    const load = createAppKeyLoader({ secretArn: SECRET_ARN, secrets: secrets.client });

    await expect(load()).rejects.toThrow(/put-secret-value/);
  });

  it('reads a local PEM for development, without touching AWS', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lugem-key-')), 'cms-app.pem');
    writeFileSync(path, PKCS1_PEM);

    await expect(createAppKeyLoader({ privateKeyPath: path })()).resolves.toMatchObject({
      type: 'private',
    });
  });

  it('refuses to guess when no source is configured', async () => {
    await expect(createAppKeyLoader({})()).rejects.toThrow(/CMS_APP_SECRET_ARN/);
  });
});

import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { type CryptoKey, importPKCS8 } from 'jose';

/** GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto only imports PKCS#8. */
const PKCS1_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

const APP_JWT_ALGORITHM = 'RS256';

/** Loads the GitHub App's signing key. Async and cached, so start-up does not depend on the network. */
export type AppKeyLoader = () => Promise<CryptoKey>;

export interface AppKeyOptions {
  /** Secrets Manager secret holding the PEM. The deployed path — requirements.md R2. */
  readonly secretArn?: string | undefined;
  /** Local development alternative. Never used in the image; the two are mutually exclusive. */
  readonly privateKeyPath?: string | undefined;
  /** Required when `secretArn` is set. Injected so this is testable without AWS. */
  readonly secrets?: SecretsManagerClient | undefined;
}

/**
 * Converts a PKCS#1 private key to PKCS#8, leaving an already-PKCS#8 key alone.
 *
 * This exists because of a mismatch nothing warns you about: the PEM GitHub gives you when you
 * create an App is PKCS#1, and `importPKCS8` rejects it with a parse error that names neither
 * format. Converting here means an operator can paste the file GitHub gave them.
 *
 * @param pem - A private key in either encoding.
 * @returns The same key, PKCS#8 encoded.
 */
export function toPkcs8(pem: string): string {
  if (!pem.includes(PKCS1_HEADER)) {
    return pem;
  }
  return createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
}

async function readPem(options: AppKeyOptions): Promise<string> {
  if (options.privateKeyPath !== undefined) {
    return readFile(options.privateKeyPath, 'utf8');
  }
  if (options.secretArn === undefined || options.secrets === undefined) {
    throw new Error('No GitHub App key source configured. Set CMS_APP_SECRET_ARN.');
  }

  const response = await options.secrets.send(
    new GetSecretValueCommand({ SecretId: options.secretArn }),
  );
  const pem = response.SecretString?.trim();
  if (pem === undefined || pem === '') {
    throw new Error(
      `Secret ${options.secretArn} is empty. The stack creates it empty on purpose — write the ` +
        'PEM with `aws secretsmanager put-secret-value` before the service can mint a token.',
    );
  }
  return pem;
}

/**
 * Builds a cached loader for the GitHub App's private key.
 *
 * The key is fetched once per process and held as a non-extractable `CryptoKey`, so the PEM itself
 * does not linger as a string that could end up in a heap dump or a log line. Loading is lazy
 * rather than done at start-up: a Secrets Manager blip should fail readiness, not stop the process
 * from booting.
 *
 * @param options - The secret ARN or local path, plus the Secrets Manager client.
 * @returns A loader that resolves the signing key, doing the work at most once.
 */
export function createAppKeyLoader(options: AppKeyOptions): AppKeyLoader {
  let key: Promise<CryptoKey> | undefined;

  return () => {
    key ??= (async () => {
      try {
        return await importPKCS8(toPkcs8(await readPem(options)), APP_JWT_ALGORITHM);
      } catch (error) {
        key = undefined;
        throw error;
      }
    })();
    return key;
  };
}

import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, REDACTED_PLACEHOLDER } from './logging';

/** Collects the NDJSON pino writes, so assertions run against what would reach CloudWatch. */
function captureLogs(): { stream: Writable; records: () => unknown[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    records: () =>
      lines
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as unknown),
  };
}

const SECRET = 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-token';

describe('createLogger', () => {
  it('emits structured JSON with the level as a label', () => {
    const { stream, records } = captureLogs();
    createLogger({ level: 'info', serviceName: 'lugem-gateway', destination: stream }).info(
      { decision: 'allowed' },
      'request handled',
    );

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: 'info',
      service: 'lugem-gateway',
      decision: 'allowed',
      msg: 'request handled',
    });
  });

  // R9: bearer tokens and identity headers must not reach the log. The ALB's `x-amzn-oidc-data`
  // is a signed JWT — a credential, even though it is not called one.
  describe('redaction', () => {
    it.each([
      ['authorization', 'authorization'],
      ['cookie', 'cookie'],
      ['x-amzn-oidc-accesstoken', 'x-amzn-oidc-accesstoken'],
      ['x-amzn-oidc-data', 'x-amzn-oidc-data'],
      ['x-amzn-oidc-identity', 'x-amzn-oidc-identity'],
    ])('scrubs the %s request header', (_case, header) => {
      const { stream, records } = captureLogs();
      const logger = createLogger({ level: 'info', destination: stream });

      logger.info({ req: { headers: { [header]: SECRET } } }, 'incoming');

      const serialised = JSON.stringify(records()[0]);
      expect(serialised).not.toContain('super-secret-token');
      expect(serialised).toContain(REDACTED_PLACEHOLDER);
    });

    it('scrubs headers logged without the req wrapper', () => {
      const { stream, records } = captureLogs();
      createLogger({ level: 'info', destination: stream }).warn(
        { headers: { authorization: SECRET } },
        'refused',
      );

      expect(JSON.stringify(records()[0])).not.toContain('super-secret-token');
    });

    it('leaves non-sensitive fields intact', () => {
      const { stream, records } = captureLogs();
      createLogger({ level: 'info', destination: stream }).info(
        { req: { headers: { authorization: SECRET, 'x-request-id': 'req-42' } } },
        'incoming',
      );

      expect(JSON.stringify(records()[0])).toContain('req-42');
    });
  });

  it('honours the configured level, so debug noise stays out of production logs', () => {
    const { stream, records } = captureLogs();
    const logger = createLogger({ level: 'warn', destination: stream });

    logger.info({}, 'not emitted');
    logger.warn({}, 'emitted');

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ level: 'warn' });
  });
});

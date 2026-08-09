import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { type AuditDecision, type AuditRecord, recordAudit } from './audit';

interface Captured {
  readonly level: string;
  readonly decision: string;
  readonly [key: string]: unknown;
}

function capture(record: AuditRecord): Captured {
  const lines: Captured[] = [];
  const logger = pino(
    { level: 'trace', formatters: { level: (label) => ({ level: label }) } },
    { write: (line: string) => lines.push(JSON.parse(line) as Captured) },
  );

  recordAudit(logger, record);
  return lines[0]!;
}

const BASE: AuditRecord = {
  subject: 'a1b2',
  email: 'sam@example.com',
  method: 'PUT',
  path: '/v1/cms/drafts/cms/pricing',
  decision: 'allowed',
  durationMs: 12,
};

describe('recordAudit', () => {
  // requirements.md R9: "Each record carries subject, email, method, path, decision, upstream
  // status and duration."
  it('carries every field the governance requirement names', () => {
    const line = capture({ ...BASE, upstreamStatus: 201 });

    expect(line).toMatchObject({
      subject: 'a1b2',
      email: 'sam@example.com',
      method: 'PUT',
      path: '/v1/cms/drafts/cms/pricing',
      decision: 'allowed',
      upstreamStatus: 201,
      durationMs: 12,
    });
  });

  // R9: "Refusals are logged at warning level so alarms key on level, not message text." The
  // message is deliberately constant across every row below — an alarm that matched on it would
  // break the first time someone reworded a log line.
  describe('level', () => {
    const cases: readonly [AuditDecision, string][] = [
      ['allowed', 'info'],
      ['refused', 'warn'],
      ['unauthorized', 'warn'],
      ['upstream-error', 'error'],
    ];

    it.each(cases)('logs %s at %s', (decision, level) => {
      expect(capture({ ...BASE, decision })).toMatchObject({ level, msg: 'gateway request' });
    });
  });

  it('records a refusal reason without an upstream status, because no call was made', () => {
    const line = capture({ ...BASE, decision: 'refused', reason: 'traversal' });

    expect(line).toMatchObject({ decision: 'refused', reason: 'traversal' });
    expect(line['upstreamStatus']).toBeUndefined();
  });

  it('leaves subject and email absent when the request was never attributed', () => {
    const line = capture({
      ...BASE,
      subject: undefined,
      email: undefined,
      decision: 'unauthorized',
      reason: 'missing-credential',
    });

    expect(line['subject']).toBeUndefined();
    expect(line['email']).toBeUndefined();
    expect(line).toMatchObject({ decision: 'unauthorized', reason: 'missing-credential' });
  });
});

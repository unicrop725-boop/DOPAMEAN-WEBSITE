import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '@/lib/logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);
  return { log, lines };
}

describe('log redaction (brief §9)', () => {
  it('redacts secrets and PII at top level and nested', () => {
    const { log, lines } = capture();
    log.info(
      {
        password: 'hunter2',
        email: 'a@b.test',
        user: { email: 'c@d.test', phone: '9999999999', token: 'abc' },
        req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } },
        keep: 'visible',
      },
      'event',
    );
    const line = JSON.stringify(lines[0]);
    for (const secret of [
      'hunter2',
      'a@b.test',
      'c@d.test',
      '9999999999',
      'Bearer x',
      'sid=1',
      '"abc"',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('visible');
  });

  it('keeps the request id child binding on every line', () => {
    const { log, lines } = capture();
    const child = log.child({ requestId: 'req-1' });
    child.info('a');
    child.warn('b');
    expect(lines.map((l) => l.requestId)).toEqual(['req-1', 'req-1']);
  });
});

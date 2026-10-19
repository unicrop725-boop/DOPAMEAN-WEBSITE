import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES, HTTP_STATUS } from '@/lib/errors';

describe('stable error codes', () => {
  it('every code has an HTTP status in the 2xx-5xx range', () => {
    for (const code of ERROR_CODES) {
      const status = HTTP_STATUS[code];
      expect(status, code).toBeGreaterThanOrEqual(200);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('has no status entries for unknown codes', () => {
    expect(Object.keys(HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('AppError exposes code, status and optional details', () => {
    const err = new AppError('PRICE_CHANGED', 'changed', { lines: 2 });
    expect(err.code).toBe('PRICE_CHANGED');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ lines: 2 });
    expect(new AppError('FORBIDDEN').message).toBe('FORBIDDEN');
  });
});

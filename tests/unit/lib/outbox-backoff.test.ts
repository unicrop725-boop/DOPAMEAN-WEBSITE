import { describe, expect, it } from 'vitest';
import { backoffSeconds } from '@/lib/outbox';

describe('outbox backoff', () => {
  it('doubles from 10s and caps at one hour', () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([10, 20, 40, 80]);
    expect(backoffSeconds(20)).toBe(3600);
    expect(backoffSeconds(0)).toBe(10);
  });
});

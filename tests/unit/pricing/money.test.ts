import { describe, expect, it } from 'vitest';
import { Money, formatBracketPrice, formatRupees } from '@/modules/pricing';

describe('Money', () => {
  it('only accepts safe integers (no floats in money paths)', () => {
    expect(() => Money.of(10.5)).toThrow(RangeError);
    expect(() => Money.of(Number.NaN)).toThrow(RangeError);
    expect(() => Money.of(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(Money.of(0).isZero()).toBe(true);
  });

  it('adds, subtracts and multiplies exactly', () => {
    expect(Money.rupees(1499).add(Money.of(1)).paise).toBe(149_901);
    expect(Money.of(100).sub(Money.of(250)).isNegative()).toBe(true);
    expect(Money.of(33).times(3).paise).toBe(99);
    expect(() => Money.of(1).times(1.5)).toThrow(RangeError);
  });

  it('classic float trap: 0.1 + 0.2 style sums stay exact in paise', () => {
    expect(Money.of(10).add(Money.of(20)).paise).toBe(30);
  });
});

describe('Money.allocate (spreading discounts / shipping across lines)', () => {
  it('parts always add up to the original amount', () => {
    const total = Money.of(100);
    const parts = total.allocate([1, 1, 1]);
    expect(parts.map((p) => p.paise)).toEqual([34, 33, 33]);
    expect(parts.reduce((a, b) => a.add(b), Money.zero()).paise).toBe(100);
  });

  it('is proportional and gives remainders to the largest fractions', () => {
    const parts = Money.of(10).allocate([3, 7]);
    expect(parts.map((p) => p.paise)).toEqual([3, 7]);
    const odd = Money.of(5).allocate([1, 2]);
    expect(odd.map((p) => p.paise)).toEqual([2, 3]);
  });

  it('handles zero weights and negative amounts', () => {
    expect(
      Money.of(9)
        .allocate([0, 1, 0])
        .map((p) => p.paise),
    ).toEqual([0, 9, 0]);
    const neg = Money.of(-100).allocate([1, 1, 1]);
    expect(neg.reduce((a, b) => a.add(b), Money.zero()).paise).toBe(-100);
  });

  it('property: for many random splits the sum is exact and every part is non-negative', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      const amount = Math.floor(rnd() * 5_000_000);
      const weights = Array.from(
        { length: 1 + Math.floor(rnd() * 8) },
        () => Math.floor(rnd() * 100_000) + 1,
      );
      const parts = Money.of(amount).allocate(weights);
      expect(parts.reduce((a, b) => a + b.paise, 0)).toBe(amount);
      expect(parts.every((p) => p.paise >= 0)).toBe(true);
    }
  });

  it('rejects empty or all-zero weights', () => {
    expect(() => Money.of(1).allocate([])).toThrow(RangeError);
    expect(() => Money.of(1).allocate([0, 0])).toThrow(RangeError);
  });
});

describe('formatting (original design style)', () => {
  it('uses Indian digit grouping', () => {
    expect(formatRupees(Money.rupees(15000))).toBe('15,000');
    expect(formatRupees(Money.rupees(150))).toBe('150');
    expect(formatRupees(Money.rupees(1234567))).toBe('12,34,567');
    expect(formatRupees(Money.of(149_950))).toBe('1,499.50');
    expect(formatRupees(Money.zero())).toBe('0');
  });

  it('wraps in the bracket style from the original pages', () => {
    expect(formatBracketPrice(Money.rupees(15000))).toBe('[ RS. 15,000 ]');
    expect(formatBracketPrice(Money.rupees(1499))).toBe('[ RS. 1,499 ]');
  });
});

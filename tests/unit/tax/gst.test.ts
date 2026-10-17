import { describe, expect, it } from 'vitest';
import { computeLineTax, extractTax, rateForUnit, splitGst, type TaxRule } from '@/modules/tax';

/** Independent reference: round-half-up of gross*rate/(10000+rate) using exact BigInt rationals. */
function reference(gross: number, rate: number): number {
  const n = BigInt(gross) * BigInt(rate);
  const d = BigInt(10_000 + rate);
  return Number((n * 2n + d) / (d * 2n));
}

describe('GST extraction from tax-inclusive prices (ADR 0005)', () => {
  it.each([
    [100_000, 500, 4_762], // Rs 1,000 at 5% -> 47.62
    [149_900, 500, 7_138], // Rs 1,499 at 5% -> 71.38
    [300_000, 1800, 45_763], // Rs 3,000 at 18% -> 457.63
    [105, 500, 5],
    [1, 500, 0],
    [0, 1800, 0],
    [12_345, 0, 0],
  ])('tax in %i paise at %i bp is %i', (gross, rate, expected) => {
    expect(extractTax(gross, rate)).toBe(expected);
  });

  it('rounds half up exactly at .5 (and not below)', () => {
    // 2125 paise at 500bp: 2125*500/10500 = 101.19..; find an exact .5 case by search to prove the boundary.
    let found = 0;
    for (let g = 1; g < 20_000 && found < 3; g++) {
      for (const rate of [500, 1200, 1800]) {
        const n = BigInt(g) * BigInt(rate);
        const d = BigInt(10_000 + rate);
        if ((n * 2n) % d === 0n && ((n * 2n) / d) % 2n === 1n) {
          // exactly x.5
          expect(extractTax(g, rate)).toBe(Number(n / d) + 1);
          found++;
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('matches the exact-rational reference for 20,000 random amounts and rates', () => {
    let seed = 987654321;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 20_000; i++) {
      const gross = Math.floor(rnd() * 5_000_000_00);
      const rate = [0, 500, 1200, 1800, 2800][Math.floor(rnd() * 5)]!;
      expect(extractTax(gross, rate), `${gross}@${rate}`).toBe(reference(gross, rate));
    }
  });

  it('never exceeds the gross and the base plus tax equals the gross', () => {
    for (const gross of [1, 99, 100, 12_345, 999_999]) {
      const t = computeLineTax({ kind: 'fixed', rateBp: 1800 }, gross, gross, true);
      expect(t.basePaise + t.taxPaise).toBe(gross);
      expect(t.taxPaise).toBeLessThanOrEqual(gross);
    }
  });

  it('rejects invalid input instead of returning garbage', () => {
    expect(() => extractTax(-1, 500)).toThrow(RangeError);
    expect(() => extractTax(10.5, 500)).toThrow(RangeError);
    expect(() => extractTax(100, 10_001)).toThrow(RangeError);
    expect(() => extractTax(100, 5.5)).toThrow(RangeError);
  });
});

describe('CGST/SGST/IGST split', () => {
  it('splits intra-state tax evenly; the odd paisa goes to SGST', () => {
    expect(splitGst(4_762, true)).toEqual({ cgstPaise: 2_381, sgstPaise: 2_381, igstPaise: 0 });
    expect(splitGst(4_763, true)).toEqual({ cgstPaise: 2_381, sgstPaise: 2_382, igstPaise: 0 });
  });

  it('charges all tax as IGST between states', () => {
    expect(splitGst(4_763, false)).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 4_763 });
  });

  it('components always add back to the tax', () => {
    for (let tax = 0; tax < 500; tax++) {
      for (const intra of [true, false]) {
        const s = splitGst(tax, intra);
        expect(s.cgstPaise + s.sgstPaise + s.igstPaise).toBe(tax);
      }
    }
  });
});

describe('slab rules decide the rate from the unit price', () => {
  const slab: TaxRule = { kind: 'slab', rateBp: 500, thresholdPaise: 250_000, rateBpAbove: 1800 };

  it('uses the lower rate up to and including the threshold, the higher rate above it', () => {
    expect(rateForUnit(slab, 249_999)).toBe(500);
    expect(rateForUnit(slab, 250_000)).toBe(500);
    expect(rateForUnit(slab, 250_001)).toBe(1800);
  });

  it('a discount does not change the slab (the unit price decides), only the amount taxed', () => {
    const full = computeLineTax(slab, 300_000, 300_000, true);
    const discounted = computeLineTax(slab, 300_000, 150_000, true);
    expect(full.rateBp).toBe(1800);
    expect(discounted.rateBp).toBe(1800);
    expect(discounted.taxPaise).toBeLessThan(full.taxPaise);
  });

  it('a missing rule means no tax', () => {
    expect(rateForUnit(null, 100_000)).toBe(0);
    expect(computeLineTax(undefined, 100_000, 100_000, true).taxPaise).toBe(0);
  });

  it('fixed rules ignore the price', () => {
    expect(rateForUnit({ kind: 'fixed', rateBp: 1200 }, 1)).toBe(1200);
    expect(rateForUnit({ kind: 'fixed', rateBp: 1200 }, 99_999_999)).toBe(1200);
  });
});

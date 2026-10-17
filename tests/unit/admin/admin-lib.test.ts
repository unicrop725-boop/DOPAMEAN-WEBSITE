import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { toActionError } from '@/lib/action-result';
import { AppError } from '@/lib/errors';
import { paiseToRupeeInput, parseRupees } from '@/lib/rupees';
import { PRODUCT_STATUSES, slugify } from '@/modules/catalog';
import {
  newVariantInput,
  productFieldsInput,
  variantFieldsInput,
} from '@/modules/catalog/domain/admin-input';
import { DASHBOARD_DEFINITIONS, REPORT_DEFINITIONS } from '@/modules/orders';

describe('parseRupees: rupee text to integer paise with no floats', () => {
  it.each([
    ['1499', 149_900],
    ['1,499', 149_900],
    ['1499.5', 149_950],
    ['1499.50', 149_950],
    ['1499.05', 149_905],
    ['0.01', 1],
    ['0', 0],
    ['  250 ', 25_000],
    ['0.29', 29], // 0.29 * 100 is 28.999999999999996 in floating point
    ['19.99', 1_999],
    ['1.10', 110],
  ])('%s -> %d', (input, paise) => {
    expect(parseRupees(input)).toBe(paise);
  });

  it.each([
    '',
    'abc',
    '-5',
    '1.234',
    '1..2',
    '1e3',
    '₹100',
    '1,2,3,4x',
    '12345678901',
    null,
    undefined,
  ])('rejects %j', (input) => {
    expect(parseRupees(input as string | null | undefined)).toBeNull();
  });

  it('round-trips through the input formatter', () => {
    for (const paise of [0, 1, 99, 100, 149_900, 149_950, 149_905, 12_345_678]) {
      expect(parseRupees(paiseToRupeeInput(paise))).toBe(paise);
    }
    expect(paiseToRupeeInput(149_900)).toBe('1499');
    expect(paiseToRupeeInput(149_905)).toBe('1499.05');
  });
});

describe('toActionError: safe messages, no leaks', () => {
  it('maps zod errors to field errors', () => {
    const err = z
      .object({ name: z.string().min(2, 'Too short'), n: z.number() })
      .safeParse({ name: 'a', n: 'x' });
    const out = toActionError(err.error as ZodError);
    expect(out.ok).toBe(false);
    expect(out.fieldErrors).toMatchObject({ name: 'Too short' });
    expect(out.code).toBe('VALIDATION_FAILED');
  });

  it('keeps field errors from AppError details and the stable code', () => {
    const out = toActionError(
      new AppError('VALIDATION_FAILED', 'That SKU is taken', { fieldErrors: { sku: 'in use' } }),
    );
    expect(out).toEqual({
      ok: false,
      message: 'That SKU is taken',
      fieldErrors: { sku: 'in use' },
      code: 'VALIDATION_FAILED',
    });
  });

  it('gives plain-language text for the codes the order screens must explain', () => {
    expect(toActionError(new AppError('ORDER_NOT_CANCELLABLE')).message).toMatch(
      /cannot be cancelled/,
    );
    expect(toActionError(new AppError('ILLEGAL_TRANSITION')).message).toMatch(/not allowed/);
    expect(toActionError(new AppError('FORBIDDEN')).message).toMatch(/permission/);
    expect(toActionError(new AppError('TWO_FACTOR_REQUIRED')).message).toMatch(/two-factor/);
    expect(toActionError(new AppError('UNAUTHENTICATED')).message).toMatch(/Sign in/);
    expect(toActionError(new AppError('REFUND_FAILED')).message).toMatch(/provider/);
  });

  it('tells the refund screen how much can still be refunded, in rupees', () => {
    const out = toActionError(
      new AppError('REFUND_EXCEEDS_CAPTURED', 'x', { availablePaise: 199_800 }),
    );
    expect(out.message).toContain('1,998');
    expect(toActionError(new AppError('REFUND_EXCEEDS_CAPTURED')).message).toMatch(/Nothing/);
  });

  it('keeps explanatory FORBIDDEN text from staff safety rules', () => {
    expect(
      toActionError(new AppError('FORBIDDEN', 'The last active owner cannot be demoted.')).message,
    ).toBe('The last active owner cannot be demoted.');
  });

  it('never leaks unexpected errors (stack, SQL, internals)', () => {
    const leaky = new Error('relation "order" does not exist at position 14: SELECT * FROM secret');
    const out = toActionError(leaky);
    expect(out).toEqual({
      ok: false,
      message: 'Something went wrong. Nothing was changed. Try again.',
    });
    expect(JSON.stringify(out)).not.toMatch(/relation|SELECT|secret|at /);
    expect(toActionError('a string')).toMatchObject({ ok: false });
  });
});

describe('catalog input rules', () => {
  it('slugify makes URL-safe slugs', () => {
    expect(slugify('Heavy Weight Hoodie!')).toBe('heavy-weight-hoodie');
    expect(slugify('  Crème brûlée -- tee ')).toBe('creme-brulee-tee');
    expect(slugify('***')).toBe('');
    expect(slugify('a'.repeat(200)).length).toBe(80);
  });

  it('product fields: blanks become null, slug must be well-formed, ids must be uuids', () => {
    const ok = productFieldsInput.parse({
      name: ' Tee ',
      slug: 'Tee-1',
      description: '',
      categoryId: '',
      hsnCode: ' 6109 ',
      taxRuleId: null,
    });
    expect(ok).toMatchObject({
      name: 'Tee',
      slug: 'tee-1',
      description: null,
      categoryId: null,
      hsnCode: '6109',
      taxRuleId: null,
    });
    expect(productFieldsInput.safeParse({ name: 'x', slug: 'bad slug' }).success).toBe(false);
    expect(
      productFieldsInput.safeParse({ name: 'x', slug: 'ok', categoryId: 'nope' }).success,
    ).toBe(false);
    expect(
      productFieldsInput.safeParse({ name: 'x', slug: 'ok', modelInfo: 'x'.repeat(301) }).success,
    ).toBe(false);
  });

  it('variant prices match the database CHECKs: price > 0, compare-at > price, integer paise', () => {
    const base = { sku: 'A-1', pricePaise: 1000 };
    expect(variantFieldsInput.safeParse(base).success).toBe(true);
    expect(variantFieldsInput.safeParse({ ...base, compareAtPaise: 1001 }).success).toBe(true);
    expect(variantFieldsInput.safeParse({ ...base, compareAtPaise: 1000 }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, compareAtPaise: 999 }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, pricePaise: 0 }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, pricePaise: -1 }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, pricePaise: 10.5 }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, pricePaise: 10 ** 12 }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, sku: 'has space' }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, sku: '' }).success).toBe(false);
    expect(variantFieldsInput.safeParse({ ...base, compareAtPaise: null }).success).toBe(true);
  });

  it('new variants need a whole, non-negative stock', () => {
    const base = { sku: 'A-1', pricePaise: 1000 };
    expect(newVariantInput.safeParse({ ...base, stock: 0 }).success).toBe(true);
    expect(newVariantInput.safeParse({ ...base, stock: -1 }).success).toBe(false);
    expect(newVariantInput.safeParse({ ...base, stock: 1.5 }).success).toBe(false);
    expect(newVariantInput.safeParse(base).success).toBe(false);
  });

  it('exposes the three product statuses', () => {
    expect([...PRODUCT_STATUSES]).toEqual(['draft', 'published', 'archived']);
  });
});

describe('written metric definitions', () => {
  it('every report and dashboard metric has a one-line definition', () => {
    for (const text of [
      ...Object.values(REPORT_DEFINITIONS),
      ...Object.values(DASHBOARD_DEFINITIONS),
    ]) {
      expect(text.length).toBeGreaterThan(30);
      expect(text).not.toContain('\n');
    }
    expect(REPORT_DEFINITIONS.grossSales).toMatch(/confirmed or completed/);
    expect(REPORT_DEFINITIONS.netSales).toMatch(/gross sales minus refunds/);
  });
});

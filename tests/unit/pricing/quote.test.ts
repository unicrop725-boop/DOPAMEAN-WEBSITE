import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  priceCart,
  signQuote,
  snapshotOf,
  verifyQuoteToken,
  type PricingSettings,
  type QuoteLineInput,
} from '@/modules/pricing';

const SECRET = 'x'.repeat(40);
const settings: PricingSettings = {
  sellerStateCode: '06',
  shippingFlatPaise: 9_900,
  freeShippingThresholdPaise: 0,
  codEnabled: true,
  codMaxPaise: 500_000,
  codFeePaise: 0,
};
const slab = { kind: 'slab', rateBp: 500, thresholdPaise: 250_000, rateBpAbove: 1800 } as const;

const line = (over: Partial<QuoteLineInput> = {}): QuoteLineInput => ({
  variantId: 'v1',
  productId: 'p1',
  sku: 'SKU-1',
  name: 'Sample Shirt',
  optionLabel: 'Size: M',
  optionValues: { Size: 'M' },
  hsnCode: '6205',
  imageKey: null,
  unitPaise: 149_900,
  qty: 1,
  available: 10,
  taxRule: slab,
  ...over,
});
const price = (lines: QuoteLineInput[], over: Partial<Parameters<typeof priceCart>[0]> = {}) =>
  priceCart({ lines, destinationStateCode: '06', paymentMethod: 'online', settings, ...over });

describe('priceCart: totals come only from database values (INV-01)', () => {
  it('single line: total equals unit price times quantity when shipping is free', () => {
    const q = price([line({ qty: 2 })]);
    expect(q.subtotalPaise).toBe(299_800);
    expect(q.shippingPaise).toBe(0);
    expect(q.totalPaise).toBe(299_800);
    expect(q.lines[0]).toMatchObject({ rateBp: 500, totalPaise: 299_800 });
  });

  it('total = sum of line totals + shipping, and tax is the sum of line taxes', () => {
    const q = price([line(), line({ variantId: 'v2', unitPaise: 399_900, taxRule: slab })]);
    expect(q.totalPaise).toBe(q.lines.reduce((s, l) => s + l.totalPaise, 0) + q.shippingPaise);
    expect(q.taxPaise).toBe(q.lines.reduce((s, l) => s + l.taxPaise, 0) + q.shippingTaxPaise);
    // 149,900 at 5% and 399,900 at 18% (slab by unit price)
    expect(q.lines.map((l) => l.rateBp)).toEqual([500, 1800]);
  });

  it('intra-state sales split CGST/SGST, inter-state sales carry IGST', () => {
    const intra = price([line()], { destinationStateCode: '06' });
    const inter = price([line()], { destinationStateCode: '27' });
    expect(intra.intraState).toBe(true);
    expect(intra.lines[0]!.igstPaise).toBe(0);
    expect(intra.lines[0]!.cgstPaise + intra.lines[0]!.sgstPaise).toBe(intra.lines[0]!.taxPaise);
    expect(inter.intraState).toBe(false);
    expect(inter.lines[0]!.cgstPaise).toBe(0);
    expect(inter.lines[0]!.igstPaise).toBe(inter.lines[0]!.taxPaise);
    expect(inter.totalPaise).toBe(intra.totalPaise); // prices are inclusive: only the tax split changes
  });

  it('charges flat shipping below the free-shipping threshold and nothing at or above it', () => {
    const s = { ...settings, freeShippingThresholdPaise: 200_000 };
    expect(price([line()], { settings: s }).shippingPaise).toBe(9_900);
    expect(price([line({ qty: 2 })], { settings: s }).shippingPaise).toBe(0);
    expect(price([line()], { settings: s }).totalPaise).toBe(149_900 + 9_900);
  });

  it('taxes shipping at the highest rate in the cart', () => {
    const s = { ...settings, freeShippingThresholdPaise: 10_000_000 };
    const q = price([line(), line({ variantId: 'v2', unitPaise: 399_900 })], { settings: s });
    expect(q.shippingPaise).toBe(9_900);
    expect(q.shippingTaxPaise).toBe(Math.floor((9_900 * 1800 * 2 + 11_800) / (2 * 11_800)));
  });

  it('spreads a discount across lines so the parts add up exactly', () => {
    const q = price([line({ unitPaise: 10_001 }), line({ variantId: 'v2', unitPaise: 20_003 })], {
      discountPaise: 7_777,
    });
    expect(q.discountPaise).toBe(7_777);
    expect(q.lines.reduce((s, l) => s + l.discountPaise, 0)).toBe(7_777);
    expect(q.totalPaise).toBe(10_001 + 20_003 - 7_777);
    expect(q.lines.every((l) => l.totalPaise === l.grossPaise - l.discountPaise)).toBe(true);
  });

  it('a discount can never exceed the subtotal (no negative totals)', () => {
    const q = price([line()], { discountPaise: 99_999_999 });
    expect(q.discountPaise).toBe(149_900);
    expect(q.totalPaise).toBe(0);
  });

  it('flags lines that exceed stock without throwing', () => {
    const q = price([line({ qty: 5, available: 3 })]);
    expect(q.issues).toEqual([
      { code: 'OUT_OF_STOCK', variantId: 'v1', available: 3, requested: 5 },
    ]);
  });

  it('cash on delivery: allowed up to the limit, refused above it or when disabled', () => {
    expect(price([line()], { paymentMethod: 'cod' }).issues).toEqual([]);
    const big = price([line({ qty: 4, unitPaise: 149_900 })], { paymentMethod: 'cod' });
    expect(big.issues).toEqual([{ code: 'COD_LIMIT_EXCEEDED', maxPaise: 500_000 }]);
    const off = price([line()], {
      paymentMethod: 'cod',
      settings: { ...settings, codEnabled: false },
    });
    expect(off.issues).toEqual([{ code: 'COD_NOT_AVAILABLE' }]);
  });

  it('adds the COD fee only for COD orders', () => {
    const s = { ...settings, codFeePaise: 5_000 };
    expect(price([line()], { settings: s, paymentMethod: 'online' }).totalPaise).toBe(149_900);
    expect(price([line()], { settings: s, paymentMethod: 'cod' }).totalPaise).toBe(154_900);
  });

  it('an empty cart prices to zero with no shipping', () => {
    const q = price([]);
    expect(q.totalPaise).toBe(0);
    expect(q.shippingPaise).toBe(0);
  });

  it('property: totals are always exact integers that add up, for random carts', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) =>
        line({
          variantId: `v${i}`,
          unitPaise: 100 + Math.floor(rnd() * 600_000),
          qty: 1 + Math.floor(rnd() * 4),
        }),
      );
      const sub = lines.reduce((s, l) => s + l.unitPaise * l.qty, 0);
      const discount = Math.floor(rnd() * sub);
      const s = { ...settings, freeShippingThresholdPaise: Math.floor(rnd() * 3_000_000) };
      const q = price(lines, { discountPaise: discount, settings: s });
      expect(Number.isSafeInteger(q.totalPaise)).toBe(true);
      expect(q.totalPaise).toBe(sub - discount + q.shippingPaise);
      expect(q.lines.reduce((a, l) => a + l.totalPaise, 0)).toBe(sub - discount);
      for (const l of q.lines) {
        expect(l.cgstPaise + l.sgstPaise + l.igstPaise).toBe(l.taxPaise);
        expect(l.basePaise + l.taxPaise).toBe(l.totalPaise);
      }
    }
  });
});

describe('pricing token: what the customer saw is what the server checks (INV-12)', () => {
  it('round-trips and detects no change when nothing moved', () => {
    const q = price([line()]);
    const seen = verifyQuoteToken(SECRET, signQuote(SECRET, q))!;
    expect(seen).not.toBeNull();
    expect(diffSnapshots(seen, snapshotOf(price([line()])))).toEqual([]);
  });

  it('rejects forged, edited, truncated or wrong-secret tokens', () => {
    const token = signQuote(SECRET, price([line()]));
    const [body, mac] = token.split('.') as [string, string];
    expect(verifyQuoteToken(SECRET, token)).not.toBeNull();
    expect(verifyQuoteToken('y'.repeat(40), token)).toBeNull();
    expect(verifyQuoteToken(SECRET, `${body}.${mac.slice(0, -2)}AA`)).toBeNull();
    const evil = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), totalPaise: 1 }),
    ).toString('base64url');
    expect(verifyQuoteToken(SECRET, `${evil}.${mac}`)).toBeNull();
    expect(verifyQuoteToken(SECRET, undefined)).toBeNull();
    expect(verifyQuoteToken(SECRET, 'garbage')).toBeNull();
    expect(verifyQuoteToken(SECRET, `${body}.${mac}.extra`)).toBeNull();
  });

  it('reports a price change with old and new values', () => {
    const seen = snapshotOf(price([line()]));
    const now = snapshotOf(price([line({ unitPaise: 159_900 })]));
    const changes = diffSnapshots(seen, now);
    expect(changes).toContainEqual({
      kind: 'price',
      variantId: 'v1',
      name: 'Sample Shirt',
      oldPaise: 149_900,
      newPaise: 159_900,
    });
    expect(changes.some((c) => c.kind === 'total')).toBe(true);
  });

  it('reports stock changes, removed and added lines, quantity changes and shipping changes', () => {
    const seen = snapshotOf(price([line({ qty: 2 }), line({ variantId: 'v2', name: 'Tee' })]));
    const now = snapshotOf(
      price([line({ qty: 1, available: 0 }), line({ variantId: 'v3', name: 'Cap' })], {
        settings: { ...settings, freeShippingThresholdPaise: 99_999_999 },
      }),
    );
    const kinds = diffSnapshots(seen, now).map((c) => c.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['quantity', 'stock', 'removed', 'added', 'shipping', 'total']),
    );
  });
});

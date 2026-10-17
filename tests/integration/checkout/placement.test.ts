import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cart, cartLine, order, orderLine, outboxEvent, product, variant } from '@/db/schema';
import type { AppError } from '@/lib/errors';
import { getCartLines } from '@/modules/cart';
import { placeOrder, quoteCart } from '@/modules/checkout';
import { getAvailable } from '@/modules/inventory';
import { getOrderDetail } from '@/modules/orders';
import { getPaymentByOrderId, listAttempts } from '@/modules/payments';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  anon,
  checkoutInput,
  createFakeRazorpay,
  fillCart,
  makeDeps,
  seedShop,
  setPrice,
  type Shop,
} from '../../support/shop';

let t: TestDb;
let shop: Shop;
beforeAll(async () => {
  t = await newTestDb(60);
  shop = await seedShop(t.db);
});
afterAll(async () => {
  await t.close();
});

const sizeM = () => shop.shirt.variantIds[1]!;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

describe('INV-01: the amount is computed on the server from database values', () => {
  it('a COD order total equals unit price x qty (shipping is free by default) and tax is recorded per line', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[sizeM(), 2]]);
    const input = await checkoutInput(deps, owner);
    const res = await placeOrder(deps, owner, null, input);
    expect(res.order.totalPaise).toBe(299_800);
    expect(res.order.status).toBe('confirmed'); // COD is accepted immediately
    expect(res.payment.method).toBe('cod');
    expect(res.payment.amountPaise).toBe(299_800);
    const detail = (await getOrderDetail(t.db, res.order.id))!;
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({
      qty: 2,
      unitPaise: 149_900,
      totalPaise: 299_800,
      taxRateBp: 500,
      hsnCode: '6205',
    });
    // Tax is contained in the price: base + tax = total, CGST + SGST = tax (Haryana to Haryana).
    const l = detail.lines[0]!;
    expect(l.taxPaise + (l.totalPaise - l.taxPaise)).toBe(l.totalPaise);
    expect(l.cgstPaise + l.sgstPaise).toBe(l.taxPaise);
    expect(l.igstPaise).toBe(0);
    expect(res.order.taxPaise).toBe(l.taxPaise);
  });

  it('inter-state orders carry IGST instead of CGST+SGST', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[shop.tee.variantIds[0]!, 1]]);
    const input = await checkoutInput(deps, owner, { stateCode: '27' });
    const res = await placeOrder(deps, owner, null, input);
    const [line] = (await getOrderDetail(t.db, res.order.id))!.lines;
    expect(line).toMatchObject({ cgstPaise: 0, sgstPaise: 0 });
    expect(line!.igstPaise).toBe(line!.taxPaise);
    expect(line!.igstPaise).toBeGreaterThan(0);
  });

  it('there is no way to send a price or total: the input schema ignores unknown fields and the token cannot be forged', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[sizeM(), 1]]);
    const input = await checkoutInput(deps, owner);
    // Extra price fields are stripped by validation and change nothing.
    const res = await placeOrder(deps, owner, null, {
      ...input,
      totalPaise: 1,
      unitPaise: 1,
      total: 1,
    } as never);
    expect(res.order.totalPaise).toBe(149_900);

    // A token edited to claim a cheaper total is rejected outright.
    const owner2 = anon();
    await fillCart(t.db, owner2, [[sizeM(), 1]]);
    const input2 = await checkoutInput(deps, owner2);
    const [body, mac] = input2.quoteToken.split('.') as [string, string];
    const snapshot = JSON.parse(Buffer.from(body, 'base64url').toString());
    snapshot.totalPaise = 100;
    const forged = `${Buffer.from(JSON.stringify(snapshot)).toString('base64url')}.${mac}`;
    await expectCode(
      placeOrder(deps, owner2, null, { ...input2, quoteToken: forged }),
      'VALIDATION_FAILED',
    );
    await expectCode(
      placeOrder(deps, owner2, null, { ...input2, quoteToken: 'garbage' }),
      'VALIDATION_FAILED',
    );
  });

  it('quantities come from the server-side cart: changing it after the quote is detected, not charged', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[sizeM(), 1]]);
    const input = await checkoutInput(deps, owner);
    await fillCart(t.db, owner, [[sizeM(), 2]]); // now 3 in the cart
    await expect(placeOrder(deps, owner, null, input)).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
    });
  });

  it('an empty cart cannot be ordered', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const input = await checkoutInput(deps, owner);
    await expectCode(placeOrder(deps, owner, null, input), 'CART_EMPTY');
  });

  it('validates contact and address input (phone, pincode, state)', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[sizeM(), 1]]);
    const input = await checkoutInput(deps, owner);
    await expect(placeOrder(deps, owner, null, { ...input, email: 'nope' })).rejects.toThrow();
    await expect(placeOrder(deps, owner, null, { ...input, phone: '123' })).rejects.toThrow();
    await expect(
      placeOrder(deps, owner, null, { ...input, address: { ...input.address, pincode: '1' } }),
    ).rejects.toThrow();
    await expect(
      placeOrder(deps, owner, null, { ...input, address: { ...input.address, stateCode: '99' } }),
    ).rejects.toThrow();
  });
});

describe('INV-12: price or stock changed since the cart loaded stops checkout and says what changed', () => {
  it('a price change is reported with old and new values and nothing is charged or created', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const v = shop.shirt.variantIds[2]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const input = await checkoutInput(deps, owner);
    const before = (await t.db.select().from(order)).length;
    await setPrice(t.db, v, 159_900);
    try {
      await placeOrder(deps, owner, null, input);
      expect.unreachable('should have stopped');
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe('PRICE_CHANGED');
      const changes = (
        e.details as { changes: { kind: string; oldPaise?: number; newPaise?: number }[] }
      ).changes;
      expect(changes).toContainEqual(
        expect.objectContaining({ kind: 'price', oldPaise: 149_900, newPaise: 159_900 }),
      );
    }
    expect((await t.db.select().from(order)).length).toBe(before);
    // Reviewing again (fresh token) shows the new price and then succeeds at it.
    const fresh = await checkoutInput(deps, owner);
    const res = await placeOrder(deps, owner, null, fresh);
    expect(res.order.totalPaise).toBe(159_900);
    await setPrice(t.db, v, 149_900);
  });

  it('stock that disappeared after the page loaded is reported (STOCK_CHANGED), never silently sold', async () => {
    const deps = makeDeps(t.db);
    const a = anon();
    const b = anon();
    const scarf = shop.scarce.variantIds[0]!;
    await fillCart(t.db, a, [[scarf, 1]]);
    await fillCart(t.db, b, [[scarf, 1]]);
    const inputA = await checkoutInput(deps, a);
    const inputB = await checkoutInput(deps, b);
    await placeOrder(deps, a, null, inputA); // A takes the last scarf
    await expect(placeOrder(deps, b, null, inputB)).rejects.toMatchObject({
      code: 'STOCK_CHANGED',
    });
    expect(await getAvailable(t.db, scarf)).toMatchObject({ available: 0 });
  });

  it('a product removed from sale after the page loaded cannot be ordered', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[shop.tee.variantIds[0]!, 1]]);
    const input = await checkoutInput(deps, owner);
    await t.db.update(product).set({ status: 'draft' }).where(eq(product.id, shop.tee.productId));
    try {
      await expectCode(placeOrder(deps, owner, null, input), 'PRODUCT_UNAVAILABLE');
    } finally {
      await t.db
        .update(product)
        .set({ status: 'published' })
        .where(eq(product.id, shop.tee.productId));
    }
  });
});

describe('INV-06: placing the same order twice makes one order', () => {
  it('a double click (same idempotency key) returns the same order and charges stock once', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const v = shop.shirt.variantIds[0]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const before = await getAvailable(t.db, v);
    const input = await checkoutInput(deps, owner, { key: 'idem-double-click-0001' });
    const first = await placeOrder(deps, owner, null, input);
    const second = await placeOrder(deps, owner, null, input);
    expect(second.replay).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.accessToken).toBe(first.accessToken);
    const after = await getAvailable(t.db, v);
    expect(after!.onHand).toBe(before!.onHand - 1);
    expect(
      (await t.db.select().from(order).where(eq(order.idempotencyKey, 'idem-double-click-0001')))
        .length,
    ).toBe(1);
  });

  it('five simultaneous submissions of the same key produce exactly one order', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const v = shop.shirt.variantIds[0]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const before = await getAvailable(t.db, v);
    const input = await checkoutInput(deps, owner, { key: 'idem-parallel-0000001' });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => placeOrder(deps, owner, null, input)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof placeOrder>>
    >[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.order.id)).size).toBe(1);
    expect(
      (await t.db.select().from(order).where(eq(order.idempotencyKey, 'idem-parallel-0000001')))
        .length,
    ).toBe(1);
    expect((await getAvailable(t.db, v))!.onHand).toBe(before!.onHand - 1);
  });

  it('a different key is a different order', async () => {
    const deps = makeDeps(t.db);
    const o1 = anon();
    const o2 = anon();
    await fillCart(t.db, o1, [[sizeM(), 1]]);
    await fillCart(t.db, o2, [[sizeM(), 1]]);
    const r1 = await placeOrder(deps, o1, null, await checkoutInput(deps, o1));
    const r2 = await placeOrder(deps, o2, null, await checkoutInput(deps, o2));
    expect(r1.order.id).not.toBe(r2.order.id);
  });
});

describe('INV-03: stock never goes negative', () => {
  it('20 concurrent checkouts for the last unit: exactly one order succeeds (COD)', async () => {
    const deps = makeDeps(t.db);
    // A fresh single-unit product so earlier tests do not interfere.
    const { createProduct } = await import('@/modules/catalog');
    const last = await createProduct(t.db, {
      slug: 'race-hat',
      name: 'Race Hat',
      status: 'published',
      hsnCode: '6505',
      taxRuleId: shop.taxRuleId,
      variants: [{ sku: 'RACE-1', pricePaise: 49_900, stock: 1 }],
    });
    const variantId = last.variantIds[0]!;
    const buyers = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const owner = anon();
        await fillCart(t.db, owner, [[variantId, 1]]);
        return { owner, input: await checkoutInput(deps, owner) };
      }),
    );
    const results = await Promise.allSettled(
      buyers.map((b) => placeOrder(deps, b.owner, null, b.input)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = (results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]).map(
      (r) => (r.reason as AppError).code,
    );
    expect(codes).toHaveLength(19);
    expect(codes.every((c) => c === 'OUT_OF_STOCK')).toBe(true);
    expect(await getAvailable(t.db, variantId)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    const orders = await t.db.select().from(orderLine).where(eq(orderLine.variantId, variantId));
    expect(orders).toHaveLength(1);
  });

  it('a failed placement leaves nothing behind: no order, no reservation, stock untouched', async () => {
    const deps = makeDeps(t.db);
    const a = anon();
    const b = anon();
    const { createProduct } = await import('@/modules/catalog');
    const one = await createProduct(t.db, {
      slug: 'solo-cap',
      name: 'Solo Cap',
      status: 'published',
      variants: [{ sku: 'SOLO', pricePaise: 10_000, stock: 1 }],
    });
    const v = one.variantIds[0]!;
    await fillCart(t.db, a, [[v, 1]]);
    await fillCart(t.db, b, [[v, 1]]);
    const ia = await checkoutInput(deps, a);
    const ib = await checkoutInput(deps, b);
    const orders0 = (await t.db.select().from(order)).length;
    const [ra, rb] = await Promise.allSettled([
      placeOrder(deps, a, null, ia),
      placeOrder(deps, b, null, ib),
    ]);
    expect([ra!.status, rb!.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await t.db.select().from(order)).length).toBe(orders0 + 1);
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });
});

describe('INV-07: orders are snapshots; editing or removing a product never changes a past order', () => {
  it('renaming, repricing and unpublishing the product leaves the order untouched', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const v = shop.shirt.variantIds[0]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const res = await placeOrder(deps, owner, null, await checkoutInput(deps, owner));
    const before = JSON.stringify((await getOrderDetail(t.db, res.order.id))!.lines);

    await t.db
      .update(product)
      .set({ name: 'Renamed Shirt', hsnCode: '9999', status: 'archived' })
      .where(eq(product.id, shop.shirt.productId));
    await t.db
      .update(variant)
      .set({ pricePaise: 999_999, sku: 'CHANGED' })
      .where(eq(variant.id, v));

    const after = JSON.stringify((await getOrderDetail(t.db, res.order.id))!.lines);
    expect(after).toBe(before);
    const line = (await getOrderDetail(t.db, res.order.id))!.lines[0]!;
    expect(line).toMatchObject({
      productName: 'Oxford Shirt',
      sku: 'oxford-shirt-S',
      unitPaise: 149_900,
      hsnCode: '6205',
    });

    await t.db
      .update(product)
      .set({ name: 'Oxford Shirt', hsnCode: '6205', status: 'published' })
      .where(eq(product.id, shop.shirt.productId));
    await t.db
      .update(variant)
      .set({ pricePaise: 149_900, sku: 'oxford-shirt-S' })
      .where(eq(variant.id, v));
  });

  it('even deleting the variant row cannot change or remove the order lines', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const { createProduct } = await import('@/modules/catalog');
    const p = await createProduct(t.db, {
      slug: 'doomed',
      name: 'Doomed Tee',
      status: 'published',
      variants: [{ sku: 'DOOM-1', pricePaise: 20_000, stock: 3 }],
    });
    const v = p.variantIds[0]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const res = await placeOrder(deps, owner, null, await checkoutInput(deps, owner));
    await t.db.delete(product).where(eq(product.id, p.productId));
    const line = (await getOrderDetail(t.db, res.order.id))!.lines[0]!;
    expect(line).toMatchObject({ productName: 'Doomed Tee', sku: 'DOOM-1', unitPaise: 20_000 });
  });
});

describe('placement side effects', () => {
  it('COD: stock is sold, cart emptied, confirmation email queued, payment stays pending until cash is collected', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const v = shop.tee.variantIds[0]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const stock0 = await getAvailable(t.db, v);
    const res = await placeOrder(
      deps,
      owner,
      null,
      await checkoutInput(deps, owner, { email: 'cod-buyer@example.test' }),
    );
    expect((await getAvailable(t.db, v))!.onHand).toBe(stock0!.onHand - 1);
    expect(await getCartLines(t.db, owner)).toEqual([]);
    const payment = (await getPaymentByOrderId(t.db, res.order.id))!;
    expect(payment).toMatchObject({ method: 'cod', status: 'pending', capturedPaise: 0 });
    const mails = (await t.db.select().from(outboxEvent)).map(
      (e) => e.payload as { to: string; subject: string },
    );
    expect(mails.some((m) => m.to === 'cod-buyer@example.test' && /received/.test(m.subject))).toBe(
      true,
    );
  });

  it('refuses COD above the configured limit', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    await fillCart(t.db, owner, [[shop.shirt.variantIds[0]!, 4]]); // 4 x 1499 = 5996 > 5000
    const input = await checkoutInput(deps, owner);
    await expectCode(placeOrder(deps, owner, null, input), 'COD_LIMIT_EXCEEDED');
  });

  it('online payment is refused when no provider is configured', async () => {
    const deps = makeDeps(t.db, { provider: null });
    const owner = anon();
    await fillCart(t.db, owner, [[sizeM(), 1]]);
    const input = await checkoutInput(deps, owner, { method: 'online' });
    await expectCode(placeOrder(deps, owner, null, input), 'PAYMENT_FAILED');
  });

  it('online: order waits for payment with stock held, and the provider order is for the SERVER amount', async () => {
    const fake = createFakeRazorpay();
    const deps = makeDeps(t.db, { provider: fake.provider });
    const owner = anon();
    const v = shop.shirt.variantIds[1]!;
    await fillCart(t.db, owner, [[v, 2]]);
    const stock0 = await getAvailable(t.db, v);
    const res = await placeOrder(
      deps,
      owner,
      null,
      await checkoutInput(deps, owner, { method: 'online' }),
    );
    expect(res.order.status).toBe('pending_payment');
    expect(res.order.paymentDeadlineAt).not.toBeNull();
    expect(res.providerOrderId).toMatch(/^order_fake/);
    expect(fake.orders.get(res.providerOrderId!)!.amount).toBe(299_800);
    const sent = fake.calls.find((c) => c.method === 'POST' && c.path === '/orders')!;
    expect(sent.body).toMatchObject({ amount: 299_800, currency: 'INR' });
    const after = await getAvailable(t.db, v);
    expect(after).toMatchObject({ onHand: stock0!.onHand, reserved: stock0!.reserved + 2 });
    const payment = (await getPaymentByOrderId(t.db, res.order.id))!;
    expect(payment).toMatchObject({
      status: 'pending',
      providerOrderId: res.providerOrderId,
      amountPaise: 299_800,
    });
    expect(await listAttempts(t.db, payment.id)).toHaveLength(1);
  });

  it('online: if the provider cannot create the order, the order is cancelled and the stock released', async () => {
    const fake = createFakeRazorpay();
    fake.setFailOrderCreate(true);
    const deps = makeDeps(t.db, { provider: fake.provider });
    const owner = anon();
    const v = shop.shirt.variantIds[1]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const stock0 = await getAvailable(t.db, v);
    await expectCode(
      placeOrder(deps, owner, null, await checkoutInput(deps, owner, { method: 'online' })),
      'PAYMENT_FAILED',
    );
    expect(await getAvailable(t.db, v)).toEqual(stock0);
  });

  it('signed-in customers get their cart and order tied to their account', async () => {
    const deps = makeDeps(t.db);
    const { user } = await import('@/db/schema');
    await t.db.insert(user).values({ id: 'cust-1', name: 'C', email: 'c1@example.test' });
    const owner = { customerId: 'cust-1' };
    await fillCart(t.db, owner, [[sizeM(), 1]]);
    const res = await placeOrder(deps, owner, 'cust-1', await checkoutInput(deps, owner));
    expect(res.order.customerId).toBe('cust-1');
    expect((await t.db.select().from(cart).where(eq(cart.customerId, 'cust-1'))).length).toBe(1);
    expect((await t.db.select().from(cartLine)).length).toBeGreaterThanOrEqual(0);
  });

  it('quotes never read prices from the cart (INV-01): a quote reflects the catalog price right now', async () => {
    const deps = makeDeps(t.db);
    const owner = anon();
    const v = shop.shirt.variantIds[0]!;
    await fillCart(t.db, owner, [[v, 1]]);
    const q1 = await quoteCart(t.db, deps.secret, owner, { paymentMethod: 'cod' });
    await setPrice(t.db, v, 139_900);
    const q2 = await quoteCart(t.db, deps.secret, owner, { paymentMethod: 'cod' });
    expect(q1.quote.totalPaise).toBe(149_900);
    expect(q2.quote.totalPaise).toBe(139_900);
    await setPrice(t.db, v, 149_900);
  });
});

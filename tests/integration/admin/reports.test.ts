import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { order, refund } from '@/db/schema';
import {
  collectCodAdmin,
  deliverOrderAdmin,
  refundOrderAdmin,
  shipOrderAdmin,
  cancelOrderAdmin,
} from '@/lib/admin/orders';
import { handleProviderWebhook, placeOrder, type CheckoutDeps } from '@/modules/checkout';
import {
  dashboardMetrics,
  istDayOf,
  istMonthStart,
  istStartOf,
  salesReport,
} from '@/modules/orders';
import { getPaymentByOrderId, listRefunds } from '@/modules/payments';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  anon,
  checkoutInput,
  createFakeRazorpay,
  fillCart,
  makeDeps,
  seedShop,
  webhook,
  type FakeRazorpay,
  type Shop,
} from '../../support/shop';
import { manager, manager2faOff, owner, support } from '../../support/admin';

let t: TestDb;
let shop: Shop;
let fake: FakeRazorpay;
let deps: CheckoutDeps;
beforeAll(async () => {
  t = await newTestDb(40);
  shop = await seedShop(t.db);
  fake = createFakeRazorpay();
  deps = makeDeps(t.db, { provider: fake.provider });
});
afterAll(async () => {
  await t.close();
});

async function placeCod(variantId: string, qty = 1) {
  const o = anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  return (await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'cod' }))).order;
}

async function placeOnline(variantId: string, qty = 1, pay = true) {
  const o = anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  const res = await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'online' }));
  if (pay) {
    const p = fake.pay(res.providerOrderId!);
    const w = webhook('payment.captured', {
      id: p.id,
      order_id: res.providerOrderId!,
      amount: p.amount,
    });
    await handleProviderWebhook(deps, fake.provider, w.rawBody, w.headers);
  }
  return res.order;
}

const placedAt = (orderId: string, iso: string) =>
  t.db
    .update(order)
    .set({ placedAt: new Date(iso) })
    .where(eq(order.id, orderId));

/** Move every refund of an order to a chosen time (refund time decides which report range it lands in). */
async function refundedAt(orderId: string, iso: string) {
  const p = (await getPaymentByOrderId(t.db, orderId))!;
  for (const r of await listRefunds(t.db, p.id)) {
    await t.db.execute(sql`UPDATE refund SET updated_at = ${new Date(iso)} WHERE id = ${r.id}`);
  }
}

describe('sales report: totals match hand-computed numbers', () => {
  // Prices: shirt Rs 1,499.00 = 149900 paise, tee Rs 799.00 = 79900 paise. Free shipping, no COD fee.
  // GST 5% included (slab rule: unit price <= Rs 2,500): tax = round_half_up(gross * 500 / 10500) per line.
  //   149900 -> 7138.095 -> 7138       79900 -> 3804.76 -> 3805       299800 -> 14276.19 -> 14276
  const range = { from: '2026-03-01', to: '2026-03-31' };

  beforeAll(async () => {
    // A: online, paid, placed exactly at the first instant of the range (IST) -> counts (149900)
    const a = await placeOnline(shop.shirt.variantIds[0]!);
    await placedAt(a.id, '2026-03-01T00:00:00+05:30');
    // B: COD tee placed in the last second of the range (IST) -> counts (79900)
    const b = await placeCod(shop.tee.variantIds[0]!);
    await placedAt(b.id, '2026-03-31T23:59:59+05:30');
    // C: COD, two shirts, shipped, delivered, cash collected -> counts (299800)
    const c = await placeCod(shop.shirt.variantIds[1]!, 2);
    await placedAt(c.id, '2026-03-15T12:00:00+05:30');
    await shipOrderAdmin(deps, owner(), c.id, { carrier: 'DTDC', trackingNo: 'DT1234567' });
    await deliverOrderAdmin(deps, owner(), c.id);
    await collectCodAdmin(deps, owner(), c.id);
    // D: COD cancelled in range -> not in gross
    const d = await placeCod(shop.shirt.variantIds[2]!);
    await placedAt(d.id, '2026-03-10T10:00:00+05:30');
    await cancelOrderAdmin(deps, owner(), d.id, { reason: 'test cancel' });
    // E: online, never paid (pending_payment) -> not in gross
    const e = await placeOnline(shop.tee.variantIds[0]!, 1, false);
    await placedAt(e.id, '2026-03-12T10:00:00+05:30');
    // F: paid online, placed the second before the range -> not in gross, but its refund inside the range counts
    const f = await placeOnline(shop.tee.variantIds[0]!);
    await placedAt(f.id, '2026-02-28T23:59:59+05:30');
    await refundOrderAdmin(deps, owner(), f.id, { amountPaise: 10_000, reason: 'partial' });
    await refundedAt(f.id, '2026-03-20T10:00:00+05:30');
    // G: paid online placed the first instant after the range -> not in gross
    const g = await placeOnline(shop.tee.variantIds[0]!);
    await placedAt(g.id, '2026-04-01T00:00:00+05:30');
    // A gets a partial refund inside the range (20000) and another one after it (5000, excluded)
    await refundOrderAdmin(deps, owner(), a.id, { amountPaise: 20_000, reason: 'in range' });
    await refundedAt(a.id, '2026-03-05T10:00:00+05:30');
    const second = await refundOrderAdmin(deps, owner(), a.id, {
      amountPaise: 5_000,
      reason: 'in april',
    });
    await t.db.execute(
      sql`UPDATE refund SET updated_at = ${new Date('2026-04-03T10:00:00+05:30')} WHERE id = ${second.id}`,
    );
    // H: paid online, cancelled (full refund 79900) in range: refund is informational only
    const h = await placeOnline(shop.tee.variantIds[0]!);
    await placedAt(h.id, '2026-03-18T10:00:00+05:30');
    await cancelOrderAdmin(deps, owner(), h.id, { reason: 'changed mind' });
    await refundedAt(h.id, '2026-03-19T10:00:00+05:30');
  });

  it('gross, count, refunds, net, average order value, tax and the online/COD split', async () => {
    const r = await salesReport(t.db, owner(), range);
    expect(r.grossSalesPaise).toBe(149_900 + 79_900 + 299_800); // 529,600
    expect(r.orderCount).toBe(3);
    expect(r.refundsPaise).toBe(20_000 + 10_000); // A in range + F in range; A in April excluded
    expect(r.cancelledRefundsPaise).toBe(79_900); // H
    expect(r.netSalesPaise).toBe(529_600 - 30_000); // 499,600
    expect(r.averageOrderValuePaise).toBe(176_533); // 529600 / 3 = 176533.33
    expect(r.taxCollectedPaise).toBe(7_138 + 3_805 + 14_276); // 25,219
    expect(r.split).toEqual({
      online: { orderCount: 1, grossSalesPaise: 149_900 },
      cod: { orderCount: 2, grossSalesPaise: 79_900 + 299_800 },
    });
    expect(r.range).toEqual(range);
  });

  it('a single day, an empty range and the month after give the matching numbers', async () => {
    const day = await salesReport(t.db, manager(), { from: '2026-03-15', to: '2026-03-15' });
    expect(day).toMatchObject({
      grossSalesPaise: 299_800,
      orderCount: 1,
      refundsPaise: 0,
      averageOrderValuePaise: 299_800,
    });
    const empty = await salesReport(t.db, manager(), { from: '2025-01-01', to: '2025-01-31' });
    expect(empty).toMatchObject({
      grossSalesPaise: 0,
      orderCount: 0,
      refundsPaise: 0,
      netSalesPaise: 0,
      averageOrderValuePaise: 0,
      taxCollectedPaise: 0,
    });
    const april = await salesReport(t.db, owner(), { from: '2026-04-01', to: '2026-04-30' });
    expect(april.grossSalesPaise).toBe(79_900); // G only
    expect(april.refundsPaise).toBe(5_000); // A's second refund lands in April
  });

  it('range edges use India time: the last IST second of March is in, the first of April is out', async () => {
    const lastDay = await salesReport(t.db, owner(), { from: '2026-03-31', to: '2026-03-31' });
    expect(lastDay.grossSalesPaise).toBe(79_900);
    const firstDay = await salesReport(t.db, owner(), { from: '2026-03-01', to: '2026-03-01' });
    expect(firstDay.grossSalesPaise).toBe(149_900);
    expect(istDayOf(new Date('2026-03-31T18:30:00Z'))).toBe('2026-04-01');
    expect(istMonthStart(new Date('2026-03-31T18:30:00Z'))).toBe('2026-04-01');
    expect(istStartOf('2026-03-01').toISOString()).toBe('2026-02-28T18:30:00.000Z');
  });

  it('validates the range', async () => {
    for (const bad of [
      { from: '2026-03-10', to: '2026-03-01' },
      { from: '2026-13-01', to: '2026-13-02' },
      { from: 'yesterday', to: 'today' },
      { from: '2024-01-01', to: '2026-03-01' },
    ]) {
      await expect(salesReport(t.db, owner(), bad)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('requires reports.view: support denied, manager without 2FA refused', async () => {
    await expect(salesReport(t.db, support(), range)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(salesReport(t.db, manager2faOff(), range)).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });

  it('reporting is read-only: the four seeded refunds are all still there', async () => {
    const rows = await t.db.select().from(refund);
    expect(rows.length).toBe(4); // F, A twice, H
  });
});

describe('dashboard metrics', () => {
  it('counts orders by status, today, awaiting shipment and awaiting COD collection', async () => {
    const now = new Date('2026-06-10T09:00:00Z'); // 14:30 IST
    const before = await dashboardMetrics(t.db, support(), now);
    // seeded above: confirmed/completed/cancelled/pending_payment orders exist; none is "today" in June
    expect(before.ordersToday).toBe(0);
    expect(before.ordersByStatus.pending_payment).toBe(1); // E
    expect(before.ordersByStatus.cancelled).toBe(2); // D, H
    expect(before.ordersByStatus.completed).toBe(1); // C
    // confirmed: A, B, F, G (online paid or COD, none shipped except C which is completed)
    expect(before.ordersByStatus.confirmed).toBe(4);
    expect(before.awaitingShipment).toBe(4);
    // COD live orders with cash not collected: B only (C was collected, D cancelled)
    expect(before.awaitingCodCollection).toBe(1);

    const o = await placeCod(shop.shirt.variantIds[0]!);
    const today = await dashboardMetrics(t.db, owner(), new Date());
    expect(today.ordersToday).toBeGreaterThanOrEqual(1);
    expect(today.awaitingCodCollection).toBe(2);
    await collectCodAdmin(deps, owner(), o.id);
    expect((await dashboardMetrics(t.db, owner(), new Date())).awaitingCodCollection).toBe(1);
  });

  it('is available to every role with orders.view, refused without 2FA', async () => {
    await expect(dashboardMetrics(t.db, manager(), new Date())).resolves.toBeDefined();
    await expect(dashboardMetrics(t.db, manager2faOff(), new Date())).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });
});

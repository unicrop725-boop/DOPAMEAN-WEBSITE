import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent, order, orderEvent, refund, shipment } from '@/db/schema';
import {
  addOrderNote,
  cancelOrderAdmin,
  collectCodAdmin,
  deliverOrderAdmin,
  listOrdersPage,
  loadOrderPage,
  refundOrderAdmin,
  shipOrderAdmin,
} from '@/lib/admin/orders';
import { handleProviderWebhook, placeOrder, type CheckoutDeps } from '@/modules/checkout';
import { getOrder } from '@/modules/orders';
import { getPaymentByOrderId } from '@/modules/payments';
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
import {
  auditCount,
  breakAuditFor,
  manager,
  manager2faOff,
  owner,
  owner2faOff,
  support,
} from '../../support/admin';

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

async function placeCod(variantId: string, qty = 1, email = 'cod@example.test') {
  const o = anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  return (await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'cod', email })))
    .order;
}

async function placePaid(variantId: string, qty = 1, email = 'online@example.test') {
  const o = anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  const res = await placeOrder(
    deps,
    o,
    null,
    await checkoutInput(deps, o, { method: 'online', email }),
  );
  const pay = fake.pay(res.providerOrderId!);
  const w = webhook('payment.captured', {
    id: pay.id,
    order_id: res.providerOrderId!,
    amount: pay.amount,
  });
  await handleProviderWebhook(deps, fake.provider, w.rawBody, w.headers);
  return res.order;
}

const ship = {
  carrier: 'Delhivery',
  trackingNo: 'DL123456789',
  trackingUrl: 'https://track.test/1',
};
const audits = (orderId: string) =>
  t.db.select().from(auditEvent).where(eq(auditEvent.entityId, orderId));
const events = (orderId: string) =>
  t.db.select().from(orderEvent).where(eq(orderEvent.orderId, orderId));

describe('ship and deliver', () => {
  it('a manager ships (shipment row, audit with ip, state) and delivers; owner works too', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    const actor = manager();
    await shipOrderAdmin(deps, actor, o.id, ship);
    expect((await getOrder(t.db, o.id))?.fulfillmentStatus).toBe('shipped');
    const [s] = await t.db.select().from(shipment).where(eq(shipment.orderId, o.id));
    expect(s).toMatchObject({
      carrier: 'Delhivery',
      trackingNo: 'DL123456789',
      createdBy: actor.userId,
    });
    const a = (await audits(o.id)).find((x) => x.action === 'order.ship')!;
    expect(a).toMatchObject({
      actorUserId: actor.userId,
      actorRole: 'manager',
      ip: '203.0.113.9',
      userAgent: 'vitest-admin',
    });
    await deliverOrderAdmin(deps, owner(), o.id);
    const after = await getOrder(t.db, o.id);
    expect(after).toMatchObject({ status: 'completed', fulfillmentStatus: 'delivered' });
    expect((await audits(o.id)).some((x) => x.action === 'order.deliver')).toBe(true);
  });

  it('delivering before shipping is an ILLEGAL_TRANSITION and shipping twice too', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    await expect(deliverOrderAdmin(deps, owner(), o.id)).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    await shipOrderAdmin(deps, owner(), o.id, ship);
    await expect(shipOrderAdmin(deps, owner(), o.id, ship)).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('validates carrier, tracking number and an https tracking link', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    for (const bad of [
      { ...ship, trackingNo: '' },
      { ...ship, trackingNo: '<script>' },
      { ...ship, carrier: '' },
      { ...ship, trackingUrl: 'http://insecure.test/x' },
      { ...ship, trackingUrl: 'javascript:alert(1)' },
    ]) {
      await expect(shipOrderAdmin(deps, owner(), o.id, bad)).rejects.toThrow();
    }
    expect((await getOrder(t.db, o.id))?.fulfillmentStatus).toBe('unfulfilled');
    expect(await t.db.select().from(shipment).where(eq(shipment.orderId, o.id))).toHaveLength(0);
  });

  it('support cannot ship or deliver; no-2FA managers/owners are refused; nothing is written', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    const before = await auditCount(t.db);
    await expect(shipOrderAdmin(deps, support(), o.id, ship)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(shipOrderAdmin(deps, manager2faOff(), o.id, ship)).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    await expect(shipOrderAdmin(deps, owner2faOff(), o.id, ship)).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    await expect(deliverOrderAdmin(deps, support(), o.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(collectCodAdmin(deps, support(), o.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await getOrder(t.db, o.id))?.fulfillmentStatus).toBe('unfulfilled');
    expect(await auditCount(t.db)).toBe(before);
  });

  it('rolls back the shipment and the state change when the audit write fails', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    const restore = await breakAuditFor(t, 'order.ship');
    try {
      await expect(shipOrderAdmin(deps, owner(), o.id, ship)).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await getOrder(t.db, o.id))?.fulfillmentStatus).toBe('unfulfilled');
    expect(await t.db.select().from(shipment).where(eq(shipment.orderId, o.id))).toHaveLength(0);
  });
});

describe('COD collection', () => {
  it('marks cash collected (payment pending to captured), audited; online orders refuse', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    expect((await getPaymentByOrderId(t.db, o.id))?.status).toBe('pending');
    await collectCodAdmin(deps, manager(), o.id);
    expect(await getPaymentByOrderId(t.db, o.id)).toMatchObject({
      status: 'captured',
      capturedPaise: 149_900,
    });
    const a = (await audits(o.id)).find((x) => x.action === 'payment.cod_collected')!;
    expect(a).toMatchObject({
      before: { status: 'pending' },
      after: { status: 'captured' },
      ip: '203.0.113.9',
    });

    const online = await placePaid(shop.tee.variantIds[0]!);
    await expect(collectCodAdmin(deps, owner(), online.id)).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
  });
});

describe('cancel', () => {
  it('cancels an unshipped paid online order: restocks, refunds in full, records who and why', async () => {
    const o = await placePaid(shop.shirt.variantIds[1]!);
    const actor = manager();
    const res = await cancelOrderAdmin(deps, actor, o.id, { reason: 'Customer changed mind' });
    expect(res.refundedPaise).toBe(149_900);
    expect(await getOrder(t.db, o.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Customer changed mind',
    });
    expect(await getPaymentByOrderId(t.db, o.id)).toMatchObject({ status: 'refunded' });
    const a = (await audits(o.id)).find((x) => x.action === 'order.cancel')!;
    expect(a).toMatchObject({ actorUserId: actor.userId, ip: '203.0.113.9' });
    expect(a.after).toMatchObject({ status: 'cancelled', reason: 'Customer changed mind' });
  });

  it('refuses ORDER_NOT_CANCELLABLE after shipment, and a missing reason', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    await shipOrderAdmin(deps, owner(), o.id, ship);
    await expect(
      cancelOrderAdmin(deps, owner(), o.id, { reason: 'too late' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_CANCELLABLE' });
    expect((await getOrder(t.db, o.id))?.status).toBe('confirmed');
    const fresh = await placeCod(shop.shirt.variantIds[0]!);
    await expect(cancelOrderAdmin(deps, owner(), fresh.id, { reason: '' })).rejects.toThrow();
    await expect(cancelOrderAdmin(deps, owner(), fresh.id, { reason: 'no' })).rejects.toThrow();
  });

  it('support cannot cancel; no-2FA manager refused', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    await expect(
      cancelOrderAdmin(deps, support(), o.id, { reason: 'because' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      cancelOrderAdmin(deps, manager2faOff(), o.id, { reason: 'because' }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    expect((await getOrder(t.db, o.id))?.status).toBe('confirmed');
  });
});

describe('refund', () => {
  it('refunds part, then the rest; refunding more than remains fails with the remaining amount', async () => {
    const o = await placePaid(shop.shirt.variantIds[0]!, 2); // Rs 2,998 = 299800
    const actor = owner();
    const r1 = await refundOrderAdmin(deps, actor, o.id, {
      amountPaise: 100_000,
      reason: 'Late delivery',
    });
    expect(r1.status).toBe('succeeded');
    expect(await getPaymentByOrderId(t.db, o.id)).toMatchObject({
      status: 'partially_refunded',
      refundedPaise: 100_000,
    });
    const err = await refundOrderAdmin(deps, actor, o.id, {
      amountPaise: 199_801,
      reason: 'Too much',
    }).catch((e) => e);
    expect(err).toMatchObject({
      code: 'REFUND_EXCEEDS_CAPTURED',
      details: { availablePaise: 199_800 },
    });
    await refundOrderAdmin(deps, actor, o.id, { amountPaise: 199_800, reason: 'Rest' });
    expect(await getPaymentByOrderId(t.db, o.id)).toMatchObject({
      status: 'refunded',
      refundedPaise: 299_800,
    });
    const audit = (await audits(o.id)).filter((x) => x.action === 'order.refund');
    expect(audit.length).toBe(2);
    expect(audit[0]).toMatchObject({ actorUserId: actor.userId, ip: '203.0.113.9' });
    expect((audit[0]!.after as { amountPaise: number }).amountPaise).toBe(100_000);
  });

  it('support cannot refund (tested), manager can, no-2FA manager cannot; nothing is refunded', async () => {
    const o = await placePaid(shop.tee.variantIds[0]!);
    const before = await auditCount(t.db);
    const calls = fake.refundCount();
    await expect(
      refundOrderAdmin(deps, support(), o.id, { amountPaise: 1000, reason: 'support try' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      refundOrderAdmin(deps, manager2faOff(), o.id, { amountPaise: 1000, reason: 'no 2fa' }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    expect(fake.refundCount()).toBe(calls);
    expect(await auditCount(t.db)).toBe(before);
    await refundOrderAdmin(deps, manager(), o.id, { amountPaise: 1000, reason: 'manager ok' });
    expect(fake.refundCount()).toBe(calls + 1);
  });

  it('validates amount and reason; an order without a payment is NOT_FOUND', async () => {
    const o = await placePaid(shop.tee.variantIds[0]!);
    for (const bad of [
      { amountPaise: 0, reason: 'zero' },
      { amountPaise: -5, reason: 'negative' },
      { amountPaise: 10.5, reason: 'fractional' },
      { amountPaise: 100, reason: '' },
    ]) {
      await expect(refundOrderAdmin(deps, owner(), o.id, bad)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(
      refundOrderAdmin(deps, owner(), '33333333-3333-4333-8333-333333333333', {
        amountPaise: 100,
        reason: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the same idempotency key twice refunds once (double click safe)', async () => {
    const o = await placePaid(shop.tee.variantIds[0]!);
    const payment = (await getPaymentByOrderId(t.db, o.id))!;
    const input = {
      amountPaise: 2500,
      reason: 'double click',
      idempotencyKey: 'click-0001-abcdef',
    };
    const a = await refundOrderAdmin(deps, owner(), o.id, input);
    const b = await refundOrderAdmin(deps, owner(), o.id, input);
    expect(b.id).toBe(a.id);
    const rows = await t.db.select().from(refund).where(eq(refund.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });

  it('COD: nothing to refund until cash is collected, then an offline refund is recorded', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    await expect(
      refundOrderAdmin(deps, owner(), o.id, { amountPaise: 1000, reason: 'before collection' }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURED' });
    await collectCodAdmin(deps, owner(), o.id);
    const r = await refundOrderAdmin(deps, owner(), o.id, {
      amountPaise: 1000,
      reason: 'goodwill',
    });
    expect(r.status).toBe('succeeded');
    expect(r.providerRefundId).toBeNull();
  });
});

describe('notes', () => {
  it('support (orders.note) can add a note: timeline event and audit event in one transaction', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    const actor = support();
    await addOrderNote(t.db, actor, o.id, { text: '  Customer asked to deliver after 6pm  ' });
    const ev = (await events(o.id)).find((e) => e.type === 'order.note')!;
    expect(ev).toMatchObject({
      actor: actor.userId,
      payload: { text: 'Customer asked to deliver after 6pm' },
    });
    const a = (await audits(o.id)).find((x) => x.action === 'order.note')!;
    expect(a).toMatchObject({ actorUserId: actor.userId, actorRole: 'support', ip: '203.0.113.9' });
  });

  it('rejects empty and over-long notes and unknown orders; refuses no-2FA owner', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    await expect(addOrderNote(t.db, owner(), o.id, { text: '   ' })).rejects.toThrow();
    await expect(addOrderNote(t.db, owner(), o.id, { text: 'x'.repeat(2001) })).rejects.toThrow();
    await expect(
      addOrderNote(t.db, owner(), '33333333-3333-4333-8333-333333333333', { text: 'hi' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(addOrderNote(t.db, owner2faOff(), o.id, { text: 'hi' })).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });

  it('rolls the note back when the audit write fails', async () => {
    const o = await placeCod(shop.shirt.variantIds[0]!);
    const restore = await breakAuditFor(t, 'order.note');
    try {
      await expect(addOrderNote(t.db, owner(), o.id, { text: 'will vanish' })).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await events(o.id)).filter((e) => e.type === 'order.note')).toHaveLength(0);
  });
});

describe('reads: list page and detail page', () => {
  it('search, filter, sort and paginate on the server; rows carry payment status and unit counts', async () => {
    const odd = await placeCod(shop.shirt.variantIds[2]!, 3, 'findme-unique@example.test');
    const byEmail = await listOrdersPage(t.db, support(), { q: 'findme-unique' });
    expect(byEmail.items).toHaveLength(1);
    expect(byEmail.items[0]).toMatchObject({ itemCount: 3, paymentStatus: 'pending' });
    expect(byEmail.items[0]!.order.id).toBe(odd.id);

    const byNumber = await listOrdersPage(t.db, owner(), { q: `#${odd.number}` });
    expect(byNumber.items.map((i) => i.order.id)).toContain(odd.id);
    const byPhone = await listOrdersPage(t.db, owner(), { q: '9876543210', pageSize: 5 });
    expect(byPhone.items.length).toBe(5);
    expect(byPhone.total).toBeGreaterThan(5);
    const byName = await listOrdersPage(t.db, owner(), { q: 'asha verma', pageSize: 3 });
    expect(byName.items).toHaveLength(3);

    const cod = await listOrdersPage(t.db, owner(), { paymentMethod: 'cod', pageSize: 100 });
    expect(cod.items.every((i) => i.order.paymentMethod === 'cod')).toBe(true);
    const shipped = await listOrdersPage(t.db, owner(), { fulfillment: 'shipped', pageSize: 100 });
    expect(shipped.items.every((i) => i.order.fulfillmentStatus === 'shipped')).toBe(true);
    const cancelled = await listOrdersPage(t.db, owner(), { status: 'cancelled', pageSize: 100 });
    expect(cancelled.items.length).toBeGreaterThan(0);

    const desc = await listOrdersPage(t.db, owner(), { sort: 'total_desc', pageSize: 100 });
    const totals = desc.items.map((i) => i.order.totalPaise);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);

    const capped = await listOrdersPage(t.db, owner(), { pageSize: 10_000 });
    expect(capped.pageSize).toBe(100);
    const p2 = await listOrdersPage(t.db, owner(), { pageSize: 5, page: 2 });
    expect(p2.page).toBe(2);
    expect(p2.items.length).toBeLessThanOrEqual(5);
  });

  it('treats search text as data (wildcards and quotes do not match everything or throw)', async () => {
    const r = await listOrdersPage(t.db, owner(), { q: '%\'; DROP TABLE "order"; --' });
    expect(r.total).toBe(0);
    const all = await listOrdersPage(t.db, owner(), {});
    expect(all.total).toBeGreaterThan(0);
  });

  it('detail page loads lines, payment, attempts, refunds, shipments and the timeline', async () => {
    const o = await placePaid(shop.shirt.variantIds[0]!);
    await refundOrderAdmin(deps, owner(), o.id, { amountPaise: 5000, reason: 'detail test' });
    await shipOrderAdmin(deps, owner(), o.id, ship);
    const page = await loadOrderPage(t.db, support(), o.id);
    expect(page?.lines).toHaveLength(1);
    expect(page?.lines[0]).toMatchObject({ hsnCode: '6205', taxRateBp: 500 });
    expect(page?.payment).toMatchObject({ status: 'partially_refunded' });
    expect(page?.attempts.length).toBeGreaterThan(0);
    expect(page?.refunds).toHaveLength(1);
    expect(page?.shipments).toHaveLength(1);
    expect(page?.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['order.placed', 'refund.succeeded', 'order.ship']),
    );
    expect(await loadOrderPage(t.db, owner(), 'not-a-uuid')).toBeNull();
    expect(await loadOrderPage(t.db, owner(), '33333333-3333-4333-8333-333333333333')).toBeNull();
  });

  it('the order list and detail refuse an owner without 2FA, and sign-out-level actors have no access', async () => {
    await expect(
      listOrdersPage(t.db, { ...owner(), role: 'owner', twoFactorEnabled: false }, {}),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    await expect(
      loadOrderPage(t.db, manager2faOff(), '33333333-3333-4333-8333-333333333333'),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    const rows = await t.db.select().from(order);
    expect(rows.length).toBeGreaterThan(0);
  });
});

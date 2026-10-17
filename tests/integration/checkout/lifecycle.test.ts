import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent, outboxEvent, payment, refund, shipment } from '@/db/schema';
import {
  cancelOrderFlow,
  collectCodFlow,
  deliverOrderFlow,
  handleProviderWebhook,
  placeOrder,
  refundPayment,
  retryStuckRefundsJob,
  shipOrderFlow,
  type CheckoutDeps,
  type StaffActor,
} from '@/modules/checkout';
import { getAvailable } from '@/modules/inventory';
import {
  getCustomerOrderDetail,
  getGuestOrderDetail,
  getOrder,
  getOrderDetail,
} from '@/modules/orders';
import { getPaymentByOrderId, listRefunds } from '@/modules/payments';
import { newTestDb, expectDbError, type TestDb } from '../../support/test-db';
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

let t: TestDb;
let shop: Shop;
let fake: FakeRazorpay;
let deps: CheckoutDeps;
beforeAll(async () => {
  t = await newTestDb(60);
  shop = await seedShop(t.db);
  fake = createFakeRazorpay();
  deps = makeDeps(t.db, { provider: fake.provider });
});
afterAll(async () => {
  await t.close();
});

const manager: StaffActor = {
  userId: 'staff-manager',
  role: 'manager',
  ip: '203.0.113.7',
  userAgent: 'vitest',
};
const owner: StaffActor = {
  userId: 'staff-owner',
  role: 'owner',
  ip: '203.0.113.8',
  userAgent: 'vitest',
};

async function placeCod(
  variantId: string,
  qty = 1,
  customerId: string | null = null,
  email = 'buyer@example.test',
) {
  const o = customerId ? { customerId } : anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  return placeOrder(deps, o, customerId, await checkoutInput(deps, o, { method: 'cod', email }));
}

/** Place an online order and complete the payment through a signed webhook. */
async function placePaid(variantId: string, qty = 1) {
  const o = anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  const res = await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'online' }));
  const pay = fake.pay(res.providerOrderId!);
  const w = webhook('payment.captured', {
    id: pay.id,
    order_id: res.providerOrderId!,
    amount: pay.amount,
  });
  await handleProviderWebhook(deps, fake.provider, w.rawBody, w.headers);
  return { res, pay };
}

const mails = async () =>
  (await t.db.select().from(outboxEvent)).map(
    (e) => e.payload as { to: string; subject: string; text: string },
  );
const auditFor = async (entityId: string) =>
  t.db.select().from(auditEvent).where(eq(auditEvent.entityId, entityId));

describe('INV-09: the refunded total never exceeds the captured total', () => {
  it('allows partial refunds that add up, and refuses anything beyond the captured amount', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 2); // Rs 2,998
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    const r1 = await refundPayment(deps, pay.id, 100_000, {
      actorUserId: manager.userId,
      staff: manager,
      reason: 'goodwill',
    });
    expect(r1.status).toBe('succeeded');
    expect((await getPaymentByOrderId(t.db, res.order.id))!).toMatchObject({
      status: 'partially_refunded',
      refundedPaise: 100_000,
    });
    await expect(
      refundPayment(deps, pay.id, 199_801, {
        actorUserId: manager.userId,
        staff: manager,
        reason: 'too much',
      }),
    ).rejects.toMatchObject({
      code: 'REFUND_EXCEEDS_CAPTURED',
    });
    await refundPayment(deps, pay.id, 199_800, {
      actorUserId: manager.userId,
      staff: manager,
      reason: 'the rest',
    });
    expect(await getPaymentByOrderId(t.db, res.order.id)).toMatchObject({
      status: 'refunded',
      refundedPaise: 299_800,
      capturedPaise: 299_800,
    });
    await expect(
      refundPayment(deps, pay.id, 1, {
        actorUserId: manager.userId,
        staff: manager,
        reason: 'again',
      }),
    ).rejects.toMatchObject({
      code: 'REFUND_EXCEEDS_CAPTURED',
    });
  });

  it('two simultaneous refunds that together exceed the captured amount: exactly one succeeds', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 1); // Rs 1,499
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    const results = await Promise.allSettled([
      refundPayment(deps, pay.id, 100_000, { actorUserId: 'a', reason: 'one' }),
      refundPayment(deps, pay.id, 100_000, { actorUserId: 'b', reason: 'two' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURED' });
    const after = (await getPaymentByOrderId(t.db, res.order.id))!;
    expect(after.refundedPaise).toBe(100_000);
    expect(after.refundedPaise).toBeLessThanOrEqual(after.capturedPaise);
  });

  it('the database itself refuses refunded > captured, even if application code were bypassed', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 1);
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    await expectDbError(
      t.db
        .update(payment)
        .set({ refundedPaise: pay.capturedPaise + 1 })
        .where(eq(payment.id, pay.id)),
      /payment_refunded_le_captured/,
    );
  });

  it('you cannot refund money that was never captured (pending online or COD not yet collected)', async () => {
    const cod = await placeCod(shop.tee.variantIds[0]!);
    const codPay = (await getPaymentByOrderId(t.db, cod.order.id))!;
    await expect(
      refundPayment(deps, codPay.id, 100, { actorUserId: 'x', reason: 'none' }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURED' });
  });

  it('refund amounts must be positive whole paise', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 1);
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    for (const bad of [0, -5, 10.5, Number.NaN]) {
      await expect(
        refundPayment(deps, pay.id, bad, { actorUserId: 'x', reason: 'bad' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('a replayed idempotency key reaches the provider once and creates one refund row', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 1);
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    const before = fake.refundCount();
    const a = await refundPayment(deps, pay.id, 50_000, {
      actorUserId: 'x',
      reason: 'r',
      idempotencyKey: 'my-refund-key-1',
    });
    const b = await refundPayment(deps, pay.id, 50_000, {
      actorUserId: 'x',
      reason: 'r',
      idempotencyKey: 'my-refund-key-1',
    });
    expect(b.id).toBe(a.id);
    expect(fake.refundCount() - before).toBe(1);
    expect(await listRefunds(t.db, pay.id)).toHaveLength(1);
    expect((await getPaymentByOrderId(t.db, res.order.id))!.refundedPaise).toBe(50_000);
    const sent = fake.calls.filter((c) => c.path.endsWith('/refund')).at(-1)!;
    expect(sent.headers['x-refund-idempotency']).toBe('my-refund-key-1');
  });

  it('a provider failure marks the refund failed, releases the amount, alerts staff and can be retried', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 1);
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    fake.setFailRefunds(true);
    await expect(
      refundPayment(deps, pay.id, 149_900, { actorUserId: 'x', reason: 'fail' }),
    ).rejects.toMatchObject({ code: 'REFUND_FAILED' });
    fake.setFailRefunds(false);
    const rows = await listRefunds(t.db, pay.id);
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect((await getPaymentByOrderId(t.db, res.order.id))!.refundedPaise).toBe(0);
    expect(
      (await mails()).some((m) => m.to === 'staff@shop.test' && /Refund failed/.test(m.subject)),
    ).toBe(true);
    // The failed attempt no longer blocks a retry of the full amount.
    const retry = await refundPayment(deps, pay.id, 149_900, { actorUserId: 'x', reason: 'retry' });
    expect(retry.status).toBe('succeeded');
  });

  it('the worker finishes a refund that was requested but never answered (crash between steps)', async () => {
    const { res } = await placePaid(shop.shirt.variantIds[0]!, 1);
    const pay = (await getPaymentByOrderId(t.db, res.order.id))!;
    const [stuck] = await t.db
      .insert(refund)
      .values({
        paymentId: pay.id,
        amountPaise: 20_000,
        reason: 'crashed',
        idempotencyKey: 'stuck-refund-key',
        createdAt: sql`now() - interval '10 minutes'` as unknown as Date,
      })
      .returning();
    const out = await retryStuckRefundsJob(deps);
    expect(out.retried).toBeGreaterThanOrEqual(1);
    const [done] = await t.db.select().from(refund).where(eq(refund.id, stuck!.id));
    expect(done).toMatchObject({ status: 'succeeded' });
    expect((await getPaymentByOrderId(t.db, res.order.id))!.refundedPaise).toBe(20_000);
  });
});

describe('cancellation (INV-09: never after shipment)', () => {
  it('cancelling a COD order before shipment puts the stock back', async () => {
    const v = shop.shirt.variantIds[1]!;
    const before = await getAvailable(t.db, v);
    const res = await placeCod(v, 2);
    expect((await getAvailable(t.db, v))!.onHand).toBe(before!.onHand - 2);
    const out = await cancelOrderFlow(deps, res.order.id, {
      actor: 'staff',
      actorId: manager.userId,
      reason: 'customer asked',
      staff: manager,
    });
    expect(out.order.status).toBe('cancelled');
    expect(await getAvailable(t.db, v)).toEqual(before);
    expect(
      (await mails()).some(
        (m) =>
          m.to === res.order.email &&
          /was cancelled/.test(m.subject) &&
          m.text.includes(`#${res.order.number}`),
      ),
    ).toBe(true);
  });

  it('cancelling a paid online order refunds it in full and restocks', async () => {
    const v = shop.shirt.variantIds[1]!;
    const before = await getAvailable(t.db, v);
    const { res } = await placePaid(v, 1);
    const out = await cancelOrderFlow(deps, res.order.id, {
      actor: 'staff',
      actorId: manager.userId,
      reason: 'out of fabric',
      staff: manager,
    });
    expect(out.refundedPaise).toBe(res.order.totalPaise);
    expect(await getPaymentByOrderId(t.db, res.order.id)).toMatchObject({
      status: 'refunded',
      refundedPaise: res.order.totalPaise,
    });
    expect(await getAvailable(t.db, v)).toEqual(before);
  });

  it('cancelling an unpaid online order releases the held stock and fails the payment', async () => {
    const v = shop.shirt.variantIds[1]!;
    const before = await getAvailable(t.db, v);
    const o = anon();
    await fillCart(t.db, o, [[v, 1]]);
    const res = await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'online' }));
    expect((await getAvailable(t.db, v))!.reserved).toBe(before!.reserved + 1);
    await cancelOrderFlow(deps, res.order.id, {
      actor: 'customer',
      actorId: 'guest',
      reason: 'changed my mind',
    });
    expect(await getAvailable(t.db, v)).toEqual(before);
    expect((await getPaymentByOrderId(t.db, res.order.id))!.status).toBe('failed');
  });

  it('a shipped order cannot be cancelled, and nothing about it changes', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await shipOrderFlow(
      deps,
      res.order.id,
      { carrier: 'Delhivery', trackingNo: 'DL1234567890' },
      manager,
    );
    const stock = await getAvailable(t.db, shop.tee.variantIds[0]!);
    await expect(
      cancelOrderFlow(deps, res.order.id, {
        actor: 'staff',
        actorId: manager.userId,
        reason: 'late',
        staff: manager,
      }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
    });
    expect(await getOrder(t.db, res.order.id)).toMatchObject({
      status: 'confirmed',
      fulfillmentStatus: 'shipped',
    });
    expect(await getAvailable(t.db, shop.tee.variantIds[0]!)).toEqual(stock);
  });

  it('cancelling twice is refused (terminal state)', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await cancelOrderFlow(deps, res.order.id, {
      actor: 'staff',
      actorId: manager.userId,
      reason: 'x',
      staff: manager,
    });
    await expect(
      cancelOrderFlow(deps, res.order.id, {
        actor: 'staff',
        actorId: manager.userId,
        reason: 'y',
        staff: manager,
      }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
    });
  });

  it('INV-13: a customer cannot cancel someone else order (it looks like it does not exist)', async () => {
    const { user } = await import('@/db/schema');
    await t.db.insert(user).values([
      { id: 'cust-a', name: 'A', email: 'a@example.test' },
      { id: 'cust-b', name: 'B', email: 'b@example.test' },
    ]);
    const res = await placeCod(shop.tee.variantIds[0]!, 1, 'cust-a', 'a@example.test');
    await expect(
      cancelOrderFlow(deps, res.order.id, {
        actor: 'customer',
        actorId: 'cust-b',
        customerId: 'cust-b',
        reason: 'not mine',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getOrder(t.db, res.order.id))!.status).toBe('confirmed');
    // The owner can.
    const ok = await cancelOrderFlow(deps, res.order.id, {
      actor: 'customer',
      actorId: 'cust-a',
      customerId: 'cust-a',
      reason: 'mine',
    });
    expect(ok.order.status).toBe('cancelled');
  });
});

describe('INV-13: customers only ever see their own orders', () => {
  it('lookups include the owner in the query; guests need the secret link token', async () => {
    const { user } = await import('@/db/schema');
    await t.db.insert(user).values([
      { id: 'cust-x', name: 'X', email: 'x@example.test' },
      { id: 'cust-y', name: 'Y', email: 'y@example.test' },
    ]);
    const orderX = await placeCod(shop.tee.variantIds[0]!, 1, 'cust-x', 'x@example.test');
    expect(await getCustomerOrderDetail(t.db, 'cust-x', orderX.order.publicId)).not.toBeNull();
    expect(await getCustomerOrderDetail(t.db, 'cust-y', orderX.order.publicId)).toBeNull();

    const guest = await placeCod(shop.tee.variantIds[0]!);
    expect(await getGuestOrderDetail(t.db, guest.order.publicId, guest.accessToken)).not.toBeNull();
    expect(await getGuestOrderDetail(t.db, guest.order.publicId, 'wrong-token')).toBeNull();
    expect(await getGuestOrderDetail(t.db, orderX.order.publicId, guest.accessToken)).toBeNull();
  });

  it('public ids are unguessable (16 characters, no sequence)', async () => {
    const a = await placeCod(shop.tee.variantIds[0]!);
    const b = await placeCod(shop.tee.variantIds[0]!);
    expect(a.order.publicId).toMatch(/^[0-9a-z]{16}$/);
    expect(a.order.publicId).not.toBe(b.order.publicId);
  });
});

describe('shipping, delivery and cash collection', () => {
  it('ship records the carrier and tracking, queues the shipped email and moves fulfilment', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!, 1, null, 'ship-me@example.test');
    const shipped = await shipOrderFlow(
      deps,
      res.order.id,
      {
        carrier: 'Blue Dart',
        trackingNo: 'BD-998877',
        trackingUrl: 'https://track.test/BD-998877',
      },
      manager,
    );
    expect(shipped).toMatchObject({ status: 'confirmed', fulfillmentStatus: 'shipped' });
    const [s] = await t.db.select().from(shipment).where(eq(shipment.orderId, res.order.id));
    expect(s).toMatchObject({
      carrier: 'Blue Dart',
      trackingNo: 'BD-998877',
      createdBy: manager.userId,
    });
    const mail = (await mails()).find(
      (m) => m.to === 'ship-me@example.test' && /has shipped/.test(m.subject),
    )!;
    expect(mail.text).toContain('BD-998877');
    expect(mail.text).toContain('https://track.test/BD-998877');
  });

  it('rejects bad tracking input and unsafe tracking links', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await expect(
      shipOrderFlow(deps, res.order.id, { carrier: 'X', trackingNo: '1' }, manager),
    ).rejects.toThrow();
    await expect(
      shipOrderFlow(
        deps,
        res.order.id,
        { carrier: 'DTDC', trackingNo: 'OK12345', trackingUrl: 'javascript:alert(1)' },
        manager,
      ),
    ).rejects.toThrow();
    await expect(
      shipOrderFlow(
        deps,
        res.order.id,
        { carrier: 'DTDC', trackingNo: 'OK12345', trackingUrl: 'http://insecure.test/x' },
        manager,
      ),
    ).rejects.toThrow();
    expect((await getOrder(t.db, res.order.id))!.fulfillmentStatus).toBe('unfulfilled');
  });

  it('cannot ship an unpaid order, ship twice, or deliver before shipping (INV-08)', async () => {
    const o = anon();
    await fillCart(t.db, o, [[shop.tee.variantIds[0]!, 1]]);
    const unpaid = await placeOrder(
      deps,
      o,
      null,
      await checkoutInput(deps, o, { method: 'online' }),
    );
    await expect(
      shipOrderFlow(deps, unpaid.order.id, { carrier: 'DTDC', trackingNo: 'NOPE1234' }, manager),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    const res = await placeCod(shop.tee.variantIds[0]!);
    await expect(deliverOrderFlow(deps, res.order.id, manager)).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    await shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'ONCE12345' }, manager);
    await expect(
      shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'TWICE12345' }, manager),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(
      await t.db.select().from(shipment).where(eq(shipment.orderId, res.order.id)),
    ).toHaveLength(1);
  });

  it('delivery completes the order; COD cash is collected by staff', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'DEL1234567' }, manager);
    const delivered = await deliverOrderFlow(deps, res.order.id, manager);
    expect(delivered).toMatchObject({ status: 'completed', fulfillmentStatus: 'delivered' });
    expect(delivered.completedAt).toBeInstanceOf(Date);
    const [s] = await t.db.select().from(shipment).where(eq(shipment.orderId, res.order.id));
    expect(s!.deliveredAt).toBeInstanceOf(Date);

    const pay = await collectCodFlow(deps, res.order.id, manager);
    expect(pay).toMatchObject({ status: 'captured', capturedPaise: res.order.totalPaise });
    // Collecting twice changes nothing.
    expect((await collectCodFlow(deps, res.order.id, manager)).status).toBe('captured');
    // A COD refund is recorded offline (no provider call) and respects the same cap.
    const before = fake.refundCount();
    const r = await refundPayment(deps, pay.id, 10_000, {
      actorUserId: owner.userId,
      staff: owner,
      reason: 'damaged',
    });
    expect(r.status).toBe('succeeded');
    expect(fake.refundCount()).toBe(before);
  });

  it('the order timeline records every step in order with the actor', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'TIME123456' }, manager);
    await deliverOrderFlow(deps, res.order.id, manager);
    const events = (await getOrderDetail(t.db, res.order.id))!.events;
    expect(events.map((e) => e.type)).toEqual([
      'order.placed',
      'order.confirm',
      'order.ship',
      'order.deliver',
    ]);
    expect(events.at(-1)!.actor).toBe(manager.userId);
    const times = events.map((e) => e.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('INV-14: every privileged action writes an audit event (who, what, before/after, when, IP)', () => {
  it('ship, deliver, cod collection, refund and cancel are all audited with actor, ip and before/after', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'AUD1234567' }, manager);
    await deliverOrderFlow(deps, res.order.id, manager);
    const pay = await collectCodFlow(deps, res.order.id, owner);
    await refundPayment(deps, pay.id, 5_000, {
      actorUserId: owner.userId,
      staff: owner,
      reason: 'audit test',
    });
    const rows = await auditFor(res.order.id);
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(byAction).sort()).toEqual([
      'order.deliver',
      'order.refund',
      'order.ship',
      'payment.cod_collected',
    ]);
    expect(byAction['order.ship']).toMatchObject({
      actorUserId: manager.userId,
      actorRole: 'manager',
      ip: '203.0.113.7',
      userAgent: 'vitest',
      entity: 'order',
    });
    expect(byAction['order.ship']!.before).toMatchObject({
      status: 'confirmed',
      fulfillment: 'unfulfilled',
    });
    expect(byAction['order.ship']!.after).toMatchObject({
      fulfillment: 'shipped',
      trackingNo: 'AUD1234567',
    });
    expect(byAction['payment.cod_collected']).toMatchObject({
      actorUserId: owner.userId,
      actorRole: 'owner',
    });
    expect(byAction['order.refund']!.after).toMatchObject({
      amountPaise: 5_000,
      reason: 'audit test',
    });
    for (const r of rows) expect(r.at).toBeInstanceOf(Date);

    const other = await placeCod(shop.tee.variantIds[0]!);
    await cancelOrderFlow(deps, other.order.id, {
      actor: 'staff',
      actorId: owner.userId,
      reason: 'dup',
      staff: owner,
    });
    const cancelAudit = (await auditFor(other.order.id)).find((r) => r.action === 'order.cancel')!;
    expect(cancelAudit.before).toMatchObject({ status: 'confirmed' });
    expect(cancelAudit.after).toMatchObject({ status: 'cancelled', reason: 'dup' });
  });

  it('a failed privileged action leaves no audit row and no partial change (atomic)', async () => {
    const res = await placeCod(shop.tee.variantIds[0]!);
    await expect(
      shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'x' }, manager),
    ).rejects.toThrow();
    expect(await auditFor(res.order.id)).toHaveLength(0);
    // Ship (valid), then an illegal second ship: the second attempt must not add a second audit row.
    await shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'ATOM12345' }, manager);
    await expect(
      shipOrderFlow(deps, res.order.id, { carrier: 'DTDC', trackingNo: 'ATOM99999' }, manager),
    ).rejects.toThrow();
    expect((await auditFor(res.order.id)).filter((r) => r.action === 'order.ship')).toHaveLength(1);
  });
});

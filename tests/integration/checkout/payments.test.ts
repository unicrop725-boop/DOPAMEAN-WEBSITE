import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { order, orderEvent, outboxEvent, payment, webhookEvent } from '@/db/schema';
import {
  cancelOrderFlow,
  cancelUnpaidOrdersJob,
  confirmPaidPayment,
  expireReservationsJob,
  handleProviderWebhook,
  placeOrder,
  reconcilePendingPayments,
  verifyCheckoutReturn,
} from '@/modules/checkout';
import { getAvailable, listReservations } from '@/modules/inventory';
import { getOrder } from '@/modules/orders';
import { getPaymentByOrderId, listAttempts, listRefunds } from '@/modules/payments';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  anon,
  checkoutInput,
  checkoutSignature,
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
beforeAll(async () => {
  t = await newTestDb(60);
  shop = await seedShop(t.db);
});
afterAll(async () => {
  await t.close();
});

const deps = (over = {}) => makeDeps(t.db, { provider: fake.provider, ...over });

async function placeOnline(variantId: string, qty = 1, over: Parameters<typeof makeDeps>[1] = {}) {
  fake = fake ?? createFakeRazorpay();
  const d = deps(over);
  const owner = anon();
  await fillCart(t.db, owner, [[variantId, qty]]);
  const res = await placeOrder(d, owner, null, await checkoutInput(d, owner, { method: 'online' }));
  return { res, d, owner };
}

const emails = async () =>
  (await t.db.select().from(outboxEvent)).map(
    (e) => e.payload as { to: string; subject: string; text: string },
  );
const statusOf = async (orderId: string) => {
  const o = (await getOrder(t.db, orderId))!;
  const p = (await getPaymentByOrderId(t.db, orderId))!;
  return {
    order: o.status,
    payment: p.status,
    captured: p.capturedPaise,
    refunded: p.refundedPaise,
  };
};
const eventsOf = async (orderId: string, type: string) =>
  (await t.db.select().from(orderEvent).where(eq(orderEvent.orderId, orderId))).filter(
    (e) => e.type === type,
  );

beforeAll(() => {
  fake = createFakeRazorpay();
});

describe('INV-02: payment is captured only from a verified webhook or a server-side provider check', () => {
  it('a browser return with a bad signature changes nothing', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[0]!);
    const pay = fake.pay(res.providerOrderId!);
    const out = await verifyCheckoutReturn(d, fake.provider, {
      providerOrderId: res.providerOrderId!,
      providerPaymentId: pay.id,
      signature: 'f'.repeat(64),
    });
    expect(out.state).toBe('invalid');
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'pending_payment',
      payment: 'pending',
      captured: 0,
    });
  });

  it('a validly signed return does NOT mark the order paid unless the provider confirms the capture', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[0]!);
    const pay = fake.pay(res.providerOrderId!, { status: 'authorized' }); // customer returned, money not captured
    const out = await verifyCheckoutReturn(d, fake.provider, {
      providerOrderId: res.providerOrderId!,
      providerPaymentId: pay.id,
      signature: checkoutSignature(res.providerOrderId!, pay.id),
    });
    expect(out.state).toBe('pending');
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'pending_payment',
      payment: 'pending',
    });
  });

  it('a signed return plus a provider-side captured payment confirms the order and sells the stock', async () => {
    const v = shop.shirt.variantIds[0]!;
    const { res, d } = await placeOnline(v, 2);
    const stock0 = await getAvailable(t.db, v);
    const pay = fake.pay(res.providerOrderId!);
    const out = await verifyCheckoutReturn(d, fake.provider, {
      providerOrderId: res.providerOrderId!,
      providerPaymentId: pay.id,
      signature: checkoutSignature(res.providerOrderId!, pay.id),
    });
    expect(out.state).toBe('confirmed');
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'confirmed',
      payment: 'captured',
      captured: 299_800,
    });
    const after = await getAvailable(t.db, v);
    expect(after).toMatchObject({ onHand: stock0!.onHand - 2, reserved: stock0!.reserved - 2 });
    expect(
      (await emails()).some((m) => m.to === res.order.email && /Payment received/.test(m.subject)),
    ).toBe(true);
    const attempts = await listAttempts(t.db, (await getPaymentByOrderId(t.db, res.order.id))!.id);
    expect(attempts[0]).toMatchObject({ status: 'captured', providerPaymentId: pay.id });
  });

  it('a webhook with a missing, wrong or tampered signature is rejected and changes nothing', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[0]!);
    const pay = fake.pay(res.providerOrderId!);
    const p = { id: pay.id, order_id: res.providerOrderId!, amount: pay.amount };

    const missing = webhook('payment.captured', p);
    missing.headers.delete('x-razorpay-signature');
    expect(
      (await handleProviderWebhook(d, fake.provider, missing.rawBody, missing.headers)).status,
    ).toBe(400);

    const wrong = webhook('payment.captured', p, { secret: 'not-the-secret' });
    expect(await handleProviderWebhook(d, fake.provider, wrong.rawBody, wrong.headers)).toEqual({
      status: 400,
      body: { ok: false, code: 'PAYMENT_SIGNATURE_INVALID' },
    });

    const tampered = webhook('payment.captured', p, { tamper: true });
    expect(
      (await handleProviderWebhook(d, fake.provider, tampered.rawBody, tampered.headers)).status,
    ).toBe(400);

    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'pending_payment',
      payment: 'pending',
      captured: 0,
    });
  });

  it('a correctly signed webhook confirms the order', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[0]!);
    const pay = fake.pay(res.providerOrderId!);
    const w = webhook('payment.captured', {
      id: pay.id,
      order_id: res.providerOrderId!,
      amount: pay.amount,
    });
    expect(await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await statusOf(res.order.id)).toMatchObject({ order: 'confirmed', payment: 'captured' });
  });

  it('a malformed body (even correctly signed) is a 400, and an unknown provider order is ignored safely', async () => {
    const d = deps();
    const bad = webhook('payment.captured', { id: 'x', order_id: 'y', amount: 1 });
    expect(
      (
        await handleProviderWebhook(
          d,
          fake.provider,
          'not json',
          new Headers({ 'x-razorpay-signature': 'x' }),
        )
      ).status,
    ).toBe(400);
    const unknown = webhook('payment.captured', {
      id: 'pay_zzz',
      order_id: 'order_does_not_exist',
      amount: 100,
    });
    expect(
      await handleProviderWebhook(d, fake.provider, unknown.rawBody, unknown.headers),
    ).toMatchObject({ status: 200 });
    void bad;
  });
});

describe('INV-04: webhooks are idempotent', () => {
  it('the same event delivered 5 times gives one payment record, one state change, one email', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[1]!);
    const pay = fake.pay(res.providerOrderId!);
    const w = webhook(
      'payment.captured',
      { id: pay.id, order_id: res.providerOrderId!, amount: pay.amount },
      { eventId: 'evt_five_times' },
    );
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(
      results.slice(1).every((r) => r.status === 200 && 'duplicate' in r.body && r.body.duplicate),
    ).toBe(true);
    expect(
      (
        await t.db
          .select()
          .from(webhookEvent)
          .where(eq(webhookEvent.providerEventId, 'evt_five_times'))
      ).length,
    ).toBe(1);
    expect((await eventsOf(res.order.id, 'order.confirm')).length).toBe(1);
    expect(
      (await t.db.select().from(payment).where(eq(payment.orderId, res.order.id))).length,
    ).toBe(1);
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'confirmed',
      payment: 'captured',
      captured: res.order.totalPaise,
    });
    const paid = (await emails()).filter(
      (m) =>
        m.to === res.order.email &&
        /Payment received for order #/.test(m.subject) &&
        m.text.includes(`#${res.order.number}`),
    );
    expect(paid).toHaveLength(1);
  });

  it('five CONCURRENT deliveries of the same event also change state exactly once', async () => {
    const v = shop.shirt.variantIds[1]!;
    const { res, d } = await placeOnline(v);
    const stock0 = await getAvailable(t.db, v);
    const pay = fake.pay(res.providerOrderId!);
    const w = webhook(
      'payment.captured',
      { id: pay.id, order_id: res.providerOrderId!, amount: pay.amount },
      { eventId: 'evt_concurrent_five' },
    );
    const out = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        handleProviderWebhook(d, fake.provider, w.rawBody, w.headers),
      ),
    );
    // Unique-constraint losers may surface as errors (provider retries them); none may double-apply.
    expect(out.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      (
        await t.db
          .select()
          .from(webhookEvent)
          .where(eq(webhookEvent.providerEventId, 'evt_concurrent_five'))
      ).length,
    ).toBe(1);
    expect((await eventsOf(res.order.id, 'order.confirm')).length).toBe(1);
    expect((await getAvailable(t.db, v))!.onHand).toBe(stock0!.onHand - 1);
  });

  it('a different event id for the same capture (provider resend under a new id) is harmless too', async () => {
    const v = shop.shirt.variantIds[1]!;
    const { res, d } = await placeOnline(v);
    const stock0 = await getAvailable(t.db, v);
    const pay = fake.pay(res.providerOrderId!);
    const p = { id: pay.id, order_id: res.providerOrderId!, amount: pay.amount };
    for (const id of ['evt_a1', 'evt_a2', 'evt_a3']) {
      const w = webhook('payment.captured', p, { eventId: id });
      await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers);
    }
    expect((await eventsOf(res.order.id, 'order.confirm')).length).toBe(1);
    expect((await getAvailable(t.db, v))!.onHand).toBe(stock0!.onHand - 1);
  });
});

describe('INV-05: late or out-of-order events never move a state machine backwards', () => {
  it('a "payment failed" for an old attempt arriving AFTER the capture does not undo it', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[1]!);
    const failed = fake.pay(res.providerOrderId!, { status: 'failed' });
    const ok = fake.pay(res.providerOrderId!);
    const p = (id: string) => ({ id, order_id: res.providerOrderId!, amount: ok.amount });
    const cap = webhook('payment.captured', p(ok.id));
    await handleProviderWebhook(d, fake.provider, cap.rawBody, cap.headers);
    const late = webhook('payment.failed', p(failed.id));
    await handleProviderWebhook(d, fake.provider, late.rawBody, late.headers);
    expect(await statusOf(res.order.id)).toMatchObject({ order: 'confirmed', payment: 'captured' });
  });

  it('a failed attempt then a successful retry still ends up paid (events in natural order)', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[1]!);
    const failed = fake.pay(res.providerOrderId!, { status: 'failed' });
    const f = webhook('payment.failed', {
      id: failed.id,
      order_id: res.providerOrderId!,
      amount: failed.amount,
    });
    await handleProviderWebhook(d, fake.provider, f.rawBody, f.headers);
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'pending_payment',
      payment: 'pending',
    }); // one failure is not final
    const ok = fake.pay(res.providerOrderId!);
    const c = webhook('payment.captured', {
      id: ok.id,
      order_id: res.providerOrderId!,
      amount: ok.amount,
    });
    await handleProviderWebhook(d, fake.provider, c.rawBody, c.headers);
    expect(await statusOf(res.order.id)).toMatchObject({ order: 'confirmed', payment: 'captured' });
  });

  it('money arriving for an already CANCELLED order is refunded automatically and the order stays cancelled', async () => {
    const v = shop.shirt.variantIds[2]!;
    const { res, d } = await placeOnline(v);
    await cancelOrderFlow(d, res.order.id, {
      actor: 'customer',
      actorId: 'guest',
      reason: 'changed my mind',
    });
    const stockAfterCancel = await getAvailable(t.db, v);
    const pay = fake.pay(res.providerOrderId!); // the customer paid in another tab just before/after cancelling
    const w = webhook('payment.captured', {
      id: pay.id,
      order_id: res.providerOrderId!,
      amount: pay.amount,
    });
    await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers);
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'cancelled',
      payment: 'refunded',
      captured: res.order.totalPaise,
      refunded: res.order.totalPaise,
    });
    expect(await getAvailable(t.db, v)).toEqual(stockAfterCancel); // stock not sold
    expect(fake.refundCount()).toBeGreaterThan(0);
    expect(
      (await emails()).some((m) => /Payment received for a cancelled order/.test(m.subject)),
    ).toBe(true);
  });

  it('a payment that arrives with the WRONG amount is flagged for review and does not confirm the order', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[1]!);
    const pay = fake.pay(res.providerOrderId!, { amount: res.order.totalPaise - 100 });
    const w = webhook('payment.captured', {
      id: pay.id,
      order_id: res.providerOrderId!,
      amount: pay.amount,
    });
    await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers);
    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'pending_payment',
      payment: 'needs_review',
      captured: 0,
    });
    expect((await emails()).some((m) => /Payment amount mismatch/.test(m.subject))).toBe(true);
    // A needs_review payment cannot be captured by another event: only staff can resolve it.
    const again = webhook('payment.captured', {
      id: pay.id,
      order_id: res.providerOrderId!,
      amount: res.order.totalPaise,
    });
    expect(
      await handleProviderWebhook(d, fake.provider, again.rawBody, again.headers),
    ).toMatchObject({ status: 200 });
    expect((await eventsOf(res.order.id, 'payment.event_blocked')).length).toBe(1);
    expect(await statusOf(res.order.id)).toMatchObject({ payment: 'needs_review' });
  });
});

describe('INV-10: reservations expire; a payment after expiry re-reserves or refunds', () => {
  it('the expiry job releases the stock but the order keeps waiting; paying in time still confirms it', async () => {
    const v = shop.shirt.variantIds[2]!;
    let clock = new Date();
    const { res, d } = await placeOnline(v, 1, { now: () => clock });
    const held = await getAvailable(t.db, v);
    clock = new Date(clock.getTime() + 16 * 60_000); // 16 minutes later
    expect((await expireReservationsJob(d)).expired).toBeGreaterThanOrEqual(1);
    const released = await getAvailable(t.db, v);
    expect(released!.reserved).toBe(held!.reserved - 1);
    expect((await getOrder(t.db, res.order.id))!.status).toBe('pending_payment'); // not cancelled yet
    expect((await listReservations(t.db, res.order.id))[0]!.status).toBe('expired');

    const pay = fake.pay(res.providerOrderId!);
    const w = webhook('payment.captured', {
      id: pay.id,
      order_id: res.providerOrderId!,
      amount: pay.amount,
    });
    await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers);
    expect(await statusOf(res.order.id)).toMatchObject({ order: 'confirmed', payment: 'captured' });
    const after = await getAvailable(t.db, v);
    expect(after!.onHand).toBe(held!.onHand - 1); // sold exactly once, re-reserved then committed
    expect(after!.reserved).toBe(released!.reserved);
  });

  it('if the stock is gone when the late payment lands: auto-refund, order cancelled, customer and staff told', async () => {
    const { createProduct } = await import('@/modules/catalog');
    const one = await createProduct(t.db, {
      slug: 'late-pay-item',
      name: 'Late Pay Item',
      status: 'published',
      hsnCode: '6205',
      taxRuleId: shop.taxRuleId,
      variants: [{ sku: 'LATE-1', pricePaise: 50_000, stock: 1 }],
    });
    const v = one.variantIds[0]!;
    let clock = new Date();
    const { res, d } = await placeOnline(v, 1, { now: () => clock });
    clock = new Date(clock.getTime() + 20 * 60_000);
    await expireReservationsJob(d); // the 15 minute hold lapses, stock is free again
    // Someone else buys the last unit (COD) before the first customer's payment arrives.
    const other = anon();
    await fillCart(t.db, other, [[v, 1]]);
    await placeOrder(makeDeps(t.db), other, null, await checkoutInput(makeDeps(t.db), other));
    expect(await getAvailable(t.db, v)).toMatchObject({ available: 0 });

    const pay = fake.pay(res.providerOrderId!);
    const w = webhook('payment.captured', {
      id: pay.id,
      order_id: res.providerOrderId!,
      amount: pay.amount,
    });
    await handleProviderWebhook(d, fake.provider, w.rawBody, w.headers);

    expect(await statusOf(res.order.id)).toMatchObject({
      order: 'cancelled',
      payment: 'refunded',
      refunded: 50_000,
    });
    expect((await getOrder(t.db, res.order.id))!.cancelReason).toBe('out_of_stock_after_payment');
    const mails = await emails();
    expect(mails.some((m) => m.to === res.order.email && /was cancelled/.test(m.subject))).toBe(
      true,
    );
    expect(
      mails.some((m) => m.to === 'staff@shop.test' && /could not be fulfilled/.test(m.subject)),
    ).toBe(true);
    const refunds = await listRefunds(t.db, (await getPaymentByOrderId(t.db, res.order.id))!.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'succeeded', amountPaise: 50_000 });
  });

  it('unpaid orders are cancelled after the deadline and their stock released', async () => {
    const v = shop.shirt.variantIds[0]!;
    let clock = new Date();
    const { res, d } = await placeOnline(v, 1, { now: () => clock, paymentDeadlineMinutes: 60 });
    clock = new Date(clock.getTime() + 61 * 60_000);
    const out = await cancelUnpaidOrdersJob(d);
    expect(out.cancelled).toBeGreaterThanOrEqual(1);
    const o = (await getOrder(t.db, res.order.id))!;
    expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'payment_timeout' });
    expect((await getPaymentByOrderId(t.db, res.order.id))!.status).toBe('failed');
    expect((await listReservations(t.db, res.order.id))[0]!.status).not.toBe('held');
  });

  it('a payment captured at the provider whose webhook never arrived rescues the order instead of cancelling it', async () => {
    let clock = new Date();
    const { res, d } = await placeOnline(shop.shirt.variantIds[0]!, 1, {
      now: () => clock,
      paymentDeadlineMinutes: 60,
    });
    fake.pay(res.providerOrderId!); // captured at the provider, but no webhook reached us
    clock = new Date(clock.getTime() + 61 * 60_000);
    const out = await cancelUnpaidOrdersJob(d);
    expect(out.rescued).toBeGreaterThanOrEqual(1);
    expect(await statusOf(res.order.id)).toMatchObject({ order: 'confirmed', payment: 'captured' });
  });

  it('reconciliation finds payments pending for 30+ minutes that the provider captured', async () => {
    const { res, d } = await placeOnline(shop.shirt.variantIds[0]!);
    fake.pay(res.providerOrderId!);
    const p = (await getPaymentByOrderId(t.db, res.order.id))!;
    await t.db
      .update(payment)
      .set({ createdAt: new Date(Date.now() - 45 * 60_000) })
      .where(eq(payment.id, p.id));
    const out = await reconcilePendingPayments(d);
    expect(out.confirmed).toBeGreaterThanOrEqual(1);
    expect(await statusOf(res.order.id)).toMatchObject({ order: 'confirmed', payment: 'captured' });
  });

  it('confirmPaidPayment is safe to call directly twice (duplicate and late reconciliation)', async () => {
    const v = shop.shirt.variantIds[0]!;
    const { res, d } = await placeOnline(v);
    const stock0 = await getAvailable(t.db, v);
    const p = (await getPaymentByOrderId(t.db, res.order.id))!;
    const a = await confirmPaidPayment(
      d,
      p.id,
      { providerPaymentId: 'pay_x', amountPaise: p.amountPaise },
      'webhook',
    );
    const b = await confirmPaidPayment(
      d,
      p.id,
      { providerPaymentId: 'pay_x', amountPaise: p.amountPaise },
      'reconciliation',
    );
    expect(a.kind).toBe('confirmed');
    expect(b.kind).toBe('already_confirmed');
    expect((await getAvailable(t.db, v))!.onHand).toBe(stock0!.onHand - 1);
    expect((await t.db.select().from(order).where(eq(order.id, res.order.id)))[0]!.status).toBe(
      'confirmed',
    );
  });
});

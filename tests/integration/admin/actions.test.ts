import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auditEvent,
  contactMessage,
  product,
  staffProfile,
  storeSetting,
  variant,
} from '@/db/schema';
import { AppError } from '@/lib/errors';
import type { ActionState } from '@/lib/action-result';
import { getOrder } from '@/modules/orders';
import { getPaymentByOrderId } from '@/modules/payments';
import { getAvailable } from '@/modules/inventory';
import { assertCan, bootstrapOwner, type AdminActor, type Role } from '@/modules/staff';
import { placeOrder, handleProviderWebhook, type CheckoutDeps } from '@/modules/checkout';
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
import { actorOf } from '../../support/admin';

/**
 * The server-action layer: form parsing, rupee conversion, permission denial, error mapping and the
 * redirect-with-notice contract. Next's request APIs are replaced (session, cache, redirect target), the
 * database, the module functions and the authorization matrix are real.
 */
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

let current: AdminActor | null;
let deps: CheckoutDeps;
vi.mock('@/lib/staff-context', async () => {
  const { assertCan } = await import('@/modules/staff');
  const { AppError } = await import('@/lib/errors');
  const authorize = async (permission: Parameters<typeof assertCan>[1]) => {
    if (!current) throw new AppError('UNAUTHENTICATED');
    assertCan(current, permission);
    return { staff: current, actor: current, admin: current };
  };
  return { requireStaffFor: authorize, resolveStaffFor: authorize, tryStaffFor: authorize };
});
vi.mock('@/lib/checkout-deps', () => ({ getCheckoutDeps: async () => deps }));

let t: TestDb;
let shop: Shop;
let fake: FakeRazorpay;
let ownerId: string;

beforeAll(async () => {
  t = await newTestDb(30);
  process.env.DATABASE_URL = t.url;
  shop = await seedShop(t.db);
  fake = createFakeRazorpay();
  deps = makeDeps(t.db, { provider: fake.provider });
  ownerId = (
    await bootstrapOwner(t.db, {
      email: 'boss@example.test',
      name: 'Boss',
      password: 'a-long-enough-password',
    })
  ).userId;
});
afterAll(async () => {
  const { closeDb } = await import('@/db/client');
  await closeDb();
  await t.close();
});

const as = (role: Role, over: Partial<AdminActor> = {}) =>
  (current = actorOf(role, { userId: role === 'owner' ? ownerId : `${role}-1`, ...over }));
const fd = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const init: ActionState = { ok: false };

/** A server action that succeeds ends in redirect(): capture where it went. */
async function redirected(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT')) return decodeURIComponent(digest.split(';')[2] ?? '');
    throw err;
  }
  throw new Error('expected the action to redirect');
}

async function placeCod(variantId: string, qty = 1) {
  const o = anon();
  await fillCart(t.db, o, [[variantId, qty]]);
  return (await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'cod' }))).order;
}
async function placePaid(variantId: string) {
  const o = anon();
  await fillCart(t.db, o, [[variantId, 1]]);
  const res = await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'online' }));
  const p = fake.pay(res.providerOrderId!);
  const w = webhook('payment.captured', {
    id: p.id,
    order_id: res.providerOrderId!,
    amount: p.amount,
  });
  await handleProviderWebhook(deps, fake.provider, w.rawBody, w.headers);
  return res.order;
}

describe('order actions', () => {
  it('ship: validates the tracking link, then ships and lands on the order with a notice key', async () => {
    const a = await import('@/app/admin/(panel)/orders/[id]/actions');
    const o = await placeCod(shop.shirt.variantIds[0]!);
    as('manager');
    const bad = await a.shipAction(
      o.id,
      init,
      fd({ carrier: 'DTDC', trackingNo: 'DT1234567', trackingUrl: 'http://insecure.test' }),
    );
    expect(bad).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fieldErrors: { trackingUrl: expect.stringContaining('https') },
    });
    expect(bad.values).toMatchObject({ trackingNo: 'DT1234567' }); // the form can show what was typed
    expect((await getOrder(t.db, o.id))?.fulfillmentStatus).toBe('unfulfilled');

    const target = await redirected(() =>
      a.shipAction(o.id, init, fd({ carrier: 'DTDC', trackingNo: 'DT1234567', trackingUrl: '' })),
    );
    expect(target).toBe(`/admin/orders/${o.id}?notice=order-shipped`);
    expect((await getOrder(t.db, o.id))?.fulfillmentStatus).toBe('shipped');

    const again = await a.shipAction(o.id, init, fd({ carrier: 'DTDC', trackingNo: 'DT7654321' }));
    expect(again).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
    expect(again.message).toMatch(/not allowed/);

    expect(await redirected(() => a.deliverAction(o.id))).toContain('notice=order-delivered');
    expect((await getOrder(t.db, o.id))?.status).toBe('completed');
  });

  it('cancel after shipment explains ORDER_NOT_CANCELLABLE; before shipment it cancels', async () => {
    const a = await import('@/app/admin/(panel)/orders/[id]/actions');
    const shipped = await placeCod(shop.shirt.variantIds[1]!);
    as('owner');
    await redirected(() =>
      a.shipAction(shipped.id, init, fd({ carrier: 'DTDC', trackingNo: 'DT0000001' })),
    );
    const refused = await a.cancelAction(shipped.id, init, fd({ reason: 'too late' }));
    expect(refused).toMatchObject({ ok: false, code: 'ORDER_NOT_CANCELLABLE' });
    expect(refused.message).toMatch(/cannot be cancelled any more/);

    const fresh = await placeCod(shop.shirt.variantIds[1]!);
    const noReason = await a.cancelAction(fresh.id, init, fd({ reason: '' }));
    expect(noReason).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    expect(
      await redirected(() => a.cancelAction(fresh.id, init, fd({ reason: 'customer asked' }))),
    ).toContain('order-cancelled');
    expect((await getOrder(t.db, fresh.id))?.status).toBe('cancelled');
  });

  it('refund: rupees become paise, the cap is explained in rupees, support is refused', async () => {
    const a = await import('@/app/admin/(panel)/orders/[id]/actions');
    const o = await placePaid(shop.tee.variantIds[0]!); // Rs 799
    as('manager');
    const notAmount = await a.refundAction(
      o.id,
      init,
      fd({ amount: 'abc', reason: 'x'.repeat(5) }),
    );
    expect(notAmount).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String) } });
    const tooMuch = await a.refundAction(o.id, init, fd({ amount: '800', reason: 'greedy' }));
    expect(tooMuch).toMatchObject({ ok: false, code: 'REFUND_EXCEEDS_CAPTURED' });
    expect(tooMuch.message).toContain('Rs. 799');

    const key = 'abcdef0123456789abcdef0123456789';
    const target = await redirected(() =>
      a.refundAction(o.id, init, fd({ amount: '100.50', reason: 'goodwill', idempotencyKey: key })),
    );
    expect(target).toContain('notice=order-refunded');
    expect((await getPaymentByOrderId(t.db, o.id))?.refundedPaise).toBe(10_050);
    // resubmitting the same dialog (same key) does not refund twice
    await redirected(() =>
      a.refundAction(o.id, init, fd({ amount: '100.50', reason: 'goodwill', idempotencyKey: key })),
    );
    expect((await getPaymentByOrderId(t.db, o.id))?.refundedPaise).toBe(10_050);

    as('support');
    const denied = await a.refundAction(o.id, init, fd({ amount: '10', reason: 'support tries' }));
    expect(denied).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('permission'),
    });
    expect((await getPaymentByOrderId(t.db, o.id))?.refundedPaise).toBe(10_050);
  });

  it('notes work for support; a signed-out request gets a session message, never a crash', async () => {
    const a = await import('@/app/admin/(panel)/orders/[id]/actions');
    const o = await placeCod(shop.shirt.variantIds[0]!);
    as('support');
    expect(await a.noteAction(o.id, init, fd({ text: 'Call before delivery' }))).toMatchObject({
      ok: true,
      message: 'Note added.',
    });
    expect(await a.noteAction(o.id, init, fd({ text: '  ' }))).toMatchObject({
      ok: false,
      fieldErrors: { text: expect.any(String) },
    });
    current = null;
    expect(await a.noteAction(o.id, init, fd({ text: 'hello' }))).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
      message: expect.stringContaining('Sign in'),
    });
    as('owner', { twoFactorEnabled: false });
    expect(await a.noteAction(o.id, init, fd({ text: 'hello' }))).toMatchObject({
      ok: false,
      code: 'TWO_FACTOR_REQUIRED',
    });
  });

  it('a tampered order id is just not found, and nothing internal is shown', async () => {
    const a = await import('@/app/admin/(panel)/orders/[id]/actions');
    as('owner');
    const res = await a.noteAction('not-a-uuid-at-all', init, fd({ text: 'boom' }));
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(JSON.stringify(res)).not.toMatch(/select|insert|relation|stack|pg_/i);
  });
});

describe('product and stock actions', () => {
  it('create: option fields, rupees and opening stock reach the module; errors come back per field', async () => {
    const a = await import('@/app/admin/(panel)/products/actions');
    as('manager');
    const bad = await a.createProductAction(
      init,
      fd({
        name: 'Linen Shirt',
        slug: '',
        sku: 'LS-1',
        opt_Size: 'M',
        pricePaise: '1499.999',
        compareAtPaise: '',
        stock: '5',
      }),
    );
    expect(bad).toMatchObject({ ok: false, fieldErrors: { pricePaise: expect.any(String) } });
    const noStock = await a.createProductAction(
      init,
      fd({
        name: 'Linen Shirt',
        slug: '',
        sku: 'LS-1',
        opt_Size: 'M',
        pricePaise: '1499',
        stock: 'many',
      }),
    );
    expect(noStock).toMatchObject({ ok: false, fieldErrors: { stock: expect.any(String) } });

    const target = await redirected(() =>
      a.createProductAction(
        init,
        fd({
          name: 'Linen Shirt',
          slug: '',
          sku: 'LS-1',
          opt_Size: 'M',
          opt_Colour: 'Sand',
          opt_Fit: '',
          pricePaise: '1,499.50',
          compareAtPaise: '1999',
          stock: '5',
          taxRuleId: shop.taxRuleId,
          hsnCode: '6205',
        }),
      ),
    );
    expect(target).toMatch(/^\/admin\/products\/[0-9a-f-]{36}\?notice=product-created$/);
    const [p] = await t.db.select().from(product).where(eq(product.slug, 'linen-shirt'));
    expect(p).toMatchObject({ status: 'draft', hsnCode: '6205' });
    const [v] = await t.db.select().from(variant).where(eq(variant.productId, p!.id));
    expect(v).toMatchObject({
      sku: 'LS-1',
      pricePaise: 149_950,
      compareAtPaise: 199_900,
      optionValues: { Size: 'M', Colour: 'Sand' },
    });
    expect((await getAvailable(t.db, v!.id))?.onHand).toBe(5);

    const dup = await a.createProductAction(
      init,
      fd({ name: 'Other', slug: 'linen-shirt', sku: 'LS-9', pricePaise: '100', stock: '1' }),
    );
    expect(dup).toMatchObject({ ok: false, fieldErrors: { slug: expect.any(String) } });
    const sku = await a.createProductAction(
      init,
      fd({ name: 'Other', slug: 'other', sku: 'LS-1', pricePaise: '100', stock: '1' }),
    );
    expect(sku).toMatchObject({ ok: false, fieldErrors: { sku: expect.any(String) } });
    expect(sku.values?.name).toBe('Other');
  });

  it('update, publish, variants, stock adjust, threshold and delete round-trip through the actions', async () => {
    const a = await import('@/app/admin/(panel)/products/actions');
    as('owner');
    const [p] = await t.db.select().from(product).where(eq(product.slug, 'linen-shirt'));
    const [v] = await t.db.select().from(variant).where(eq(variant.productId, p!.id));

    expect(
      await a.updateProductAction(
        p!.id,
        init,
        fd({
          name: 'Linen Shirt v2',
          slug: 'linen-shirt',
          description: 'Cool',
          categoryId: '',
          hsnCode: '6205',
          taxRuleId: shop.taxRuleId,
        }),
      ),
    ).toMatchObject({ ok: true });
    expect((await t.db.select().from(product).where(eq(product.id, p!.id)))[0]?.name).toBe(
      'Linen Shirt v2',
    );

    expect(await a.setStatusAction(p!.id, 'published')).toMatchObject({ ok: true });
    expect(await a.setStatusAction(p!.id, 'published')).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(await a.setVariantActiveAction(p!.id, v!.id, false)).toMatchObject({
      ok: false,
      message: expect.stringContaining('last active variant'),
    });

    expect(
      await a.addVariantAction(
        p!.id,
        init,
        fd({ sku: 'LS-2', opt_Size: 'L', pricePaise: '1499', stock: '2' }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await a.updateVariantAction(
        p!.id,
        v!.id,
        init,
        fd({ sku: 'LS-1', opt_Size: 'M', pricePaise: '1399', compareAtPaise: '1199' }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { compareAtPaise: expect.any(String) },
    });
    expect(
      await a.updateVariantAction(
        p!.id,
        v!.id,
        init,
        fd({ sku: 'LS-1', opt_Size: 'M', pricePaise: '1399' }),
      ),
    ).toMatchObject({ ok: true });
    expect((await t.db.select().from(variant).where(eq(variant.id, v!.id)))[0]?.pricePaise).toBe(
      139_900,
    );

    expect(
      await a.adjustStockAction(
        v!.id,
        '/x',
        init,
        fd({ delta: '-2', reason: 'correction', note: 'recount' }),
      ),
    ).toMatchObject({ ok: true, message: expect.stringContaining('3 on hand') });
    expect(
      await a.adjustStockAction(v!.id, '/x', init, fd({ delta: 'abc', note: 'x' })),
    ).toMatchObject({ ok: false, fieldErrors: { delta: expect.any(String) } });
    expect(
      await a.adjustStockAction(v!.id, '/x', init, fd({ delta: '-99', note: 'too many' })),
    ).toMatchObject({ ok: false, code: 'OUT_OF_STOCK' });
    expect(await a.setThresholdAction(v!.id, '/x', init, fd({ threshold: '2' }))).toMatchObject({
      ok: true,
    });
    as('manager');
    expect(
      await a.adjustStockAction(v!.id, '/x', init, fd({ delta: '1', note: 'manager can' })),
    ).toMatchObject({ ok: true });
    as('support');
    expect(
      await a.adjustStockAction(v!.id, '/x', init, fd({ delta: '1', note: 'support cannot' })),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await a.updateProductAction(p!.id, init, fd({ name: 'Hacked', slug: 'linen-shirt' })),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await a.setStatusAction(p!.id, 'archived')).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });

    as('owner');
    const del = await redirected(() => a.deleteProductAction(p!.id));
    expect(del).toBe('/admin/products?notice=product-deleted');
    expect(await t.db.select().from(product).where(eq(product.id, p!.id))).toHaveLength(0);
  });

  it('categories and collections', async () => {
    const a = await import('@/app/admin/(panel)/products/actions');
    as('manager');
    expect(
      await a.createCategoryAction(
        init,
        fd({ name: 'Bottoms', slug: '', parentId: '', position: '1' }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await a.createCategoryAction(init, fd({ name: 'Bottoms', slug: 'bottoms' })),
    ).toMatchObject({ ok: false, fieldErrors: { slug: expect.any(String) } });
    expect(
      await a.createCollectionAction(init, fd({ name: 'Autumn', slug: '', published: 'on' })),
    ).toMatchObject({ ok: true });
    const { listCategoriesAdmin, listCollectionsAdmin } = await import('@/modules/catalog');
    const cat = (await listCategoriesAdmin(t.db, current!)).find((c) => c.slug === 'bottoms')!;
    const col = (await listCollectionsAdmin(t.db, current!)).find((c) => c.slug === 'autumn')!;
    expect(col.published).toBe(true);
    expect(
      await a.updateCollectionAction(
        col.id,
        init,
        fd({ name: 'Autumn', slug: 'autumn', position: '0' }),
      ),
    ).toMatchObject({ ok: true }); // box unchecked: unpublished
    expect(
      (await listCollectionsAdmin(t.db, current!)).find((c) => c.id === col.id)?.published,
    ).toBe(false);
    expect(await a.deleteCategoryAction(cat.id)).toMatchObject({
      ok: true,
      message: expect.stringContaining('0 product'),
    });
    expect(await a.deleteCollectionAction(col.id)).toMatchObject({ ok: true });
  });
});

describe('settings, staff, content and message actions', () => {
  it('settings: rupees to paise, errors named after the form fields, audited, owner only', async () => {
    const a = await import('@/app/admin/(panel)/settings/actions');
    const form = (over: Record<string, string> = {}) =>
      fd({
        storeName: 'DOPAMEAN',
        contactEmail: 'owner@example.test',
        gstin: '',
        sellerStateCode: '06',
        shippingFlat: '79',
        freeShippingThreshold: '1999',
        codEnabled: 'on',
        codMax: '3000',
        codFee: '49.50',
        ...over,
      });
    as('owner');
    const bad = await a.saveSettingsAction(init, form({ shippingFlat: 'free' }));
    expect(bad).toMatchObject({ ok: false, fieldErrors: { shippingFlat: expect.any(String) } });
    const badGstin = await a.saveSettingsAction(init, form({ gstin: 'nope' }));
    expect(badGstin).toMatchObject({ ok: false, fieldErrors: { gstin: expect.any(String) } });

    expect(await redirected(() => a.saveSettingsAction(init, form()))).toBe(
      '/admin/settings?notice=settings-saved',
    );
    const [row] = await t.db.select().from(storeSetting).where(eq(storeSetting.key, 'store'));
    expect(row!.value).toMatchObject({
      shippingFlatPaise: 7_900,
      freeShippingThresholdPaise: 199_900,
      codFeePaise: 4_950,
      codMaxPaise: 300_000,
      codEnabled: true,
    });
    const audits = await t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'settings.update'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: ownerId, ip: '203.0.113.9' });

    // an unchecked COD box turns COD off
    await redirected(() =>
      a.saveSettingsAction(
        init,
        fd({
          storeName: 'DOPAMEAN',
          contactEmail: '',
          sellerStateCode: '06',
          shippingFlat: '79',
          freeShippingThreshold: '0',
          codMax: '3000',
          codFee: '0',
        }),
      ),
    );
    expect(
      ((await t.db.select().from(storeSetting))[0]!.value as { codEnabled: boolean }).codEnabled,
    ).toBe(false);

    as('manager');
    expect(await a.saveSettingsAction(init, form())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('tax rules: percent text to basis points', async () => {
    const a = await import('@/app/admin/(panel)/settings/actions');
    as('owner');
    expect(
      await redirected(() =>
        a.createTaxRuleAction(init, fd({ name: 'Flat', kind: 'fixed', rate: '12.5' })),
      ),
    ).toBe('/admin/settings?notice=tax-rule-created');
    expect(
      await a.createTaxRuleAction(init, fd({ name: 'x', kind: 'fixed', rate: '' })),
    ).toMatchObject({ ok: false, fieldErrors: { rate: expect.any(String) } });
    expect(
      await a.createTaxRuleAction(
        init,
        fd({ name: 'Slab', kind: 'slab', rate: '5', slabThreshold: '', rateAbove: '12' }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { slabThreshold: expect.any(String) },
    });
    const { listTaxRules } = await import('@/modules/tax');
    const rules = await listTaxRules(t.db);
    expect(rules.find((r) => r.name === 'Flat')?.rateBp).toBe(1250);
  });

  it('staff: create, change role, deactivate with the safety rules and messages', async () => {
    const a = await import('@/app/admin/(panel)/staff/actions');
    as('owner');
    const weak = await a.createStaffAction(
      init,
      fd({ name: 'New', email: 'new@example.test', role: 'support', password: 'short' }),
    );
    expect(weak).toMatchObject({ ok: false, fieldErrors: { password: expect.any(String) } });
    expect(weak.values).not.toHaveProperty('password'); // passwords are never sent back
    expect(
      await redirected(() =>
        a.createStaffAction(
          init,
          fd({
            name: 'New',
            email: 'new@example.test',
            role: 'support',
            password: 'a-long-enough-password',
          }),
        ),
      ),
    ).toContain('staff-created');
    const [created] = await t.db
      .select()
      .from(staffProfile)
      .where(eq(staffProfile.role, 'support'));
    expect(await a.changeRoleAction(created!.userId, init, fd({ role: 'manager' }))).toMatchObject({
      ok: true,
      message: 'Role changed to manager.',
    });
    expect(await a.changeRoleAction(ownerId, init, fd({ role: 'support' }))).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('own role'),
    });
    expect(await a.setActiveAction(ownerId, false)).toMatchObject({
      ok: false,
      message: expect.stringContaining('your own'),
    });
    expect(await a.setActiveAction(created!.userId, false)).toMatchObject({ ok: true });
    expect(await a.setActiveAction(created!.userId, true)).toMatchObject({ ok: true });
    as('manager');
    expect(await a.setActiveAction(created!.userId, false)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('content and messages', async () => {
    const c = await import('@/app/admin/(panel)/content/actions');
    const m = await import('@/app/admin/(panel)/messages/actions');
    as('manager');
    expect(await c.saveContentAction('faq', init, fd({ title: '', body: 'x' }))).toMatchObject({
      ok: false,
      fieldErrors: { title: expect.any(String) },
    });
    expect(
      await redirected(() =>
        c.saveContentAction(
          'faq',
          init,
          fd({ title: 'FAQ', body: '## A\r\n\r\nB', published: 'on' }),
        ),
      ),
    ).toBe('/admin/content/faq?notice=content-saved');
    expect(
      await c.saveContentAction('invented', init, fd({ title: 'T', body: 'x' })),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    as('support');
    expect(
      await c.saveContentAction('faq', init, fd({ title: 'Hacked', body: 'x' })),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const [msg] = await t.db
      .insert(contactMessage)
      .values({ name: 'A', email: 'a@example.test', message: 'Is this in stock?' })
      .returning();
    expect(await m.setHandledAction(msg!.id, true)).toMatchObject({
      ok: true,
      message: 'Message marked as handled.',
    });
    expect(await m.setHandledAction(msg!.id, true)).toMatchObject({ ok: false });
    expect(await m.setHandledAction(msg!.id, false)).toMatchObject({ ok: true });
  });
});

describe('the permission helper used by every action is the real matrix', () => {
  it('support has no refund permission', () => {
    expect(() => assertCan(actorOf('support'), 'orders.refund')).toThrow(AppError);
  });
});

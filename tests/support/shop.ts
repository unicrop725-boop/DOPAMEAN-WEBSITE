import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { product } from '../../src/db/schema';
import type { Db } from '../../src/db/client';
import { addProductMedia, createCategory, createProduct } from '../../src/modules/catalog';
import { addToCart, type CartOwner } from '../../src/modules/cart';
import { createRazorpayProvider, type PaymentProvider } from '../../src/modules/payments';
import { DEFAULT_APPAREL_RULE, createTaxRule } from '../../src/modules/tax';
import { quoteCart, type CheckoutDeps, type PlaceOrderInput } from '../../src/modules/checkout';

export const SECRET = 'test-secret-test-secret-test-secret-0123';
export const WEBHOOK_SECRET = 'whsec_test_webhook_secret';
export const KEY_SECRET = 'rzp_test_key_secret';

/**
 * In-memory Razorpay: the REAL adapter (request formats, signature maths) talks to this fake `fetch`.
 * It exists only in tests (brief §7). `pay()` simulates the customer paying in the hosted checkout.
 */
export function createFakeRazorpay() {
  type FakePayment = { id: string; order_id: string; status: string; amount: number };
  const orders = new Map<string, { id: string; amount: number }>();
  const payments: FakePayment[] = [];
  const refunds = new Map<string, { id: string; payment_id: string; amount: number }>();
  const calls: { method: string; path: string; headers: Record<string, string>; body?: unknown }[] =
    [];
  let seq = 0;
  let failRefunds = false;
  let failOrderCreate = false;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, headers, body });
    if (!headers.authorization?.startsWith('Basic ')) return json(401, { error: 'unauthorised' });

    if (method === 'POST' && path === '/orders') {
      if (failOrderCreate) return json(500, { error: 'boom' });
      const id = `order_fake${++seq}`;
      orders.set(id, { id, amount: body.amount });
      return json(200, { id });
    }
    const listMatch = path.match(/^\/orders\/([^/]+)\/payments$/);
    if (method === 'GET' && listMatch) {
      return json(200, { items: payments.filter((p) => p.order_id === listMatch[1]) });
    }
    const refundMatch = path.match(/^\/payments\/([^/]+)\/refund$/);
    if (method === 'POST' && refundMatch) {
      if (failRefunds) return json(500, { error: 'refund rejected' });
      const key = headers['x-refund-idempotency'];
      if (key && refunds.has(key)) return json(200, { id: refunds.get(key)!.id });
      const id = `rfnd_fake${++seq}`;
      refunds.set(key ?? id, { id, payment_id: refundMatch[1]!, amount: body.amount });
      return json(200, { id });
    }
    return json(404, { error: 'not found' });
  };

  const provider: PaymentProvider = createRazorpayProvider(
    { keyId: 'rzp_test_key', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
    fakeFetch,
  );

  return {
    provider,
    calls,
    orders,
    refunds,
    setFailRefunds: (v: boolean) => (failRefunds = v),
    setFailOrderCreate: (v: boolean) => (failOrderCreate = v),
    /** The customer paid (or failed to) in the hosted checkout. */
    pay(providerOrderId: string, opts: { status?: string; amount?: number } = {}) {
      const order = orders.get(providerOrderId)!;
      const p: FakePayment = {
        id: `pay_fake${++seq}`,
        order_id: providerOrderId,
        status: opts.status ?? 'captured',
        amount: opts.amount ?? order.amount,
      };
      payments.push(p);
      return p;
    },
    refundCount: () => refunds.size,
  };
}

export type FakeRazorpay = ReturnType<typeof createFakeRazorpay>;

/** A correctly signed webhook request exactly as Razorpay would send it. */
export function webhook(
  event: 'payment.captured' | 'payment.failed' | 'refund.processed',
  p: { id: string; order_id: string; amount: number },
  opts: {
    eventId?: string;
    secret?: string;
    tamper?: boolean;
    extra?: Record<string, unknown>;
  } = {},
) {
  const body = JSON.stringify({
    entity: 'event',
    event,
    payload: {
      payment: {
        entity: {
          id: p.id,
          order_id: p.order_id,
          amount: p.amount,
          status: event === 'payment.failed' ? 'failed' : 'captured',
        },
      },
      ...opts.extra,
    },
  });
  const signature = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  const headers = new Headers({
    'x-razorpay-signature': signature,
    'x-razorpay-event-id': opts.eventId ?? `evt_${randomUUID()}`,
  });
  return {
    rawBody: opts.tamper ? body.replace(String(p.amount), String(p.amount + 1)) : body,
    headers,
  };
}

export function checkoutSignature(
  providerOrderId: string,
  providerPaymentId: string,
  secret = KEY_SECRET,
) {
  return createHmac('sha256', secret)
    .update(`${providerOrderId}|${providerPaymentId}`)
    .digest('hex');
}

export type Shop = {
  shirt: { productId: string; variantIds: string[]; slug: string };
  tee: { productId: string; variantIds: string[]; slug: string };
  scarce: { productId: string; variantIds: string[]; slug: string };
  taxRuleId: string;
};

/** A small catalog: a Rs 1,499 shirt (60 each of S/M/L), a Rs 799 tee (60) and a single-unit scarf. */
export async function seedShop(db: Db): Promise<Shop> {
  const taxRuleId = await createTaxRule(db, DEFAULT_APPAREL_RULE);
  const category = await createCategory(db, { slug: 'tops', name: 'Tops' });
  const make = async (
    slug: string,
    name: string,
    price: number,
    sizes: string[],
    stock: number,
  ) => {
    const r = await createProduct(db, {
      slug,
      name,
      status: 'published',
      categoryId: category,
      hsnCode: '6205',
      taxRuleId,
      variants: sizes.map((s) => ({
        sku: `${slug}-${s}`,
        optionValues: { Size: s },
        pricePaise: price,
        stock,
      })),
    });
    await addProductMedia(db, r.productId, {
      objectKey: `/assets/${slug}.png`,
      alt: name,
      width: 10,
      height: 10,
      position: 0,
    });
    return { ...r, slug };
  };
  return {
    shirt: await make('oxford-shirt', 'Oxford Shirt', 149_900, ['S', 'M', 'L'], 60),
    tee: await make('boxy-tee', 'Boxy Tee', 79_900, ['M'], 60),
    scarce: await make('last-scarf', 'Last Scarf', 29_900, ['One'], 1),
    taxRuleId,
  };
}

export function makeDeps(db: Db, over: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    db,
    secret: SECRET,
    provider: null,
    baseUrl: 'https://shop.test',
    reservationTtlMinutes: 15,
    paymentDeadlineMinutes: 60,
    staffInbox: 'staff@shop.test',
    ...over,
  };
}

export const anon = (): CartOwner => ({ anonToken: randomUUID().replaceAll('-', '') + 'x' });

export const ADDRESS = {
  fullName: 'Asha Verma',
  line1: '12 Test Street',
  city: 'Panipat',
  stateCode: '06',
  pincode: '132103',
  phone: '9876543210',
};

/** What the checkout page does: add to cart, quote, and keep the signed token. */
export async function fillCart(db: Db, owner: CartOwner, items: [string, number][]) {
  for (const [variantId, qty] of items) await addToCart(db, owner, variantId, qty);
}

export async function checkoutInput(
  deps: CheckoutDeps,
  owner: CartOwner,
  opts: { method?: 'online' | 'cod'; key?: string; stateCode?: string; email?: string } = {},
): Promise<PlaceOrderInput> {
  const method = opts.method ?? 'cod';
  const stateCode = opts.stateCode ?? '06';
  const cq = await quoteCart(deps.db, deps.secret, owner, {
    destinationStateCode: stateCode,
    paymentMethod: method,
  });
  return {
    email: opts.email ?? 'asha@example.test',
    phone: '9876543210',
    address: { ...ADDRESS, stateCode },
    paymentMethod: method,
    idempotencyKey: opts.key ?? `key-${randomUUID()}`,
    quoteToken: cq.token,
  };
}

export async function setPrice(db: Db, variantId: string, paise: number) {
  const { variant } = await import('../../src/db/schema');
  await db.update(variant).set({ pricePaise: paise }).where(eq(variant.id, variantId));
}

export async function unpublish(db: Db, productId: string) {
  await db.update(product).set({ status: 'draft' }).where(eq(product.id, productId));
}

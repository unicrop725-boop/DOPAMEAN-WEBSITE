import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { dbUrl } from './env';
import { fakeRzp, returnSignature, signedWebhook } from './fake-razorpay';
import { firstUrl, waitForEmail } from './support';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });
test.afterAll(async () => {
  await pool.end();
});

const run = Date.now();
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];
const scalar = async (sql: string, params: unknown[] = []) =>
  Object.values((await q(sql, params))[0] ?? {})[0];

const shirt = async (size: string) =>
  (await scalar(
    "select v.id from variant v join product p on p.id = v.product_id where p.slug = 'sample-oxford-shirt' and v.option_values->>'Size' = $1",
    [size],
  )) as string;
const onHand = async (variantId: string) =>
  Number(await scalar('select on_hand from inventory_level where variant_id = $1', [variantId]));
const ordersFor = async (email: string) =>
  q<{ id: string; status: string; public_id: string; total_paise: string }>(
    'select id, status, public_id, total_paise from "order" where email = $1 order by placed_at',
    [email],
  );

async function addShirt(page: Page, size = 'M') {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/products/sample-oxford-shirt');
  await page.waitForLoadState('networkidle');
  await page.locator('.size-selector button', { hasText: new RegExp(`^${size}$`) }).click();
  await page.locator('.add-to-cart-bar').click();
  await expect(page.locator('div[role=status]')).toContainText('Added to bag');
}

async function fillCheckout(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('Full name').fill('Asha Verma');
  await page.getByLabel('Address line 1').fill('12 Test Street');
  await page.getByLabel('City').fill('Panipat');
  await page.getByLabel('Pincode').fill('132103');
  await page.getByLabel('Phone for the courier').fill('9876543210');
}

const place = (page: Page) => page.getByRole('button', { name: /Place order|Continue to payment/ });

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test.describe('bag and cart', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.11' } });

  test('add to bag updates BAG[n], the cart page shows server-computed totals, quantity and remove work', async ({
    page,
  }) => {
    await addShirt(page, 'M');
    await expect(page.locator('.nav-box-user-links a', { hasText: 'BAG[1]' })).toBeVisible();

    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: /SHOPPING BAG \[01\]/ })).toBeVisible();
    const line = page.locator('li.sp-cart-line');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('Sample Oxford Shirt');
    await expect(line).toContainText('SIZE: M');
    await expect(page.getByLabel('Order summary')).toContainText('[ RS. 1,499 ]');
    await expect(page.getByLabel('Order summary')).toContainText('FREE');

    await page.getByRole('button', { name: 'Increase quantity' }).click();
    await expect(page.getByLabel('Order summary').locator('dd').last()).toHaveText('[ RS. 2,998 ]');
    await page.getByRole('button', { name: 'Decrease quantity' }).click();
    await expect(page.getByLabel('Order summary').locator('dd').last()).toHaveText('[ RS. 1,499 ]');

    await page.getByRole('button', { name: /Remove Sample Oxford Shirt/ }).click();
    await expect(page.getByText('Your bag is empty.')).toBeVisible();
  });

  test('a sold-out size cannot be added, and the bag refuses more than is in stock', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/products/sample-oxford-shirt');
    await expect(page.locator('.size-selector button', { hasText: 'XXXL' })).toBeDisabled();
    const v = await shirt('L');
    const res = await page.request.post('/api/cart/items', {
      data: { variantId: v, qty: 10 },
      headers: { origin: 'http://localhost:3100' },
    });
    expect(res.ok()).toBe(true); // stock is 10
    const over = await page.request.post('/api/cart/items', {
      data: { variantId: v, qty: 1 },
      headers: { origin: 'http://localhost:3100' },
    });
    expect(over.status()).toBe(409);
    expect((await over.json()).code).toBe('QTY_EXCEEDS_AVAILABLE');
    await page.request.delete('/api/cart/items', {
      data: { variantId: v },
      headers: { origin: 'http://localhost:3100' },
    });
  });

  test('cart API refuses cross-site requests (CSRF) and junk input', async ({ request }) => {
    const v = await shirt('M');
    const noOrigin = await request.post('/api/cart/items', { data: { variantId: v } });
    expect(noOrigin.status()).toBe(403);
    expect((await noOrigin.json()).code).toBe('CSRF_FAILED');
    const evil = await request.post('/api/cart/items', {
      data: { variantId: v },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status()).toBe(403);
    const bad = await request.post('/api/cart/items', {
      data: { variantId: 'not-a-uuid' },
      headers: { origin: 'http://localhost:3100' },
    });
    expect(bad.status()).toBe(400);
    const unknown = await request.post('/api/cart/items', {
      data: { variantId: '00000000-0000-4000-8000-000000000000' },
      headers: { origin: 'http://localhost:3100' },
    });
    expect(unknown.status()).toBe(409);
    expect((await unknown.json()).code).toBe('PRODUCT_UNAVAILABLE');
  });

  test('cart line that is over stock is flagged and checkout is blocked', async ({ page }) => {
    await addShirt(page, 'S');
    const v = await shirt('S');
    const before = await onHand(v);
    await pool.query('update inventory_level set on_hand = 0 where variant_id = $1', [v]);
    try {
      await page.goto('/cart');
      await expect(page.getByText('Sold out.')).toBeVisible();
      await expect(page.getByText('Secure checkout')).toHaveAttribute('aria-disabled', 'true');
      await page.goto('/checkout');
      await expect(page).toHaveURL(/\/cart/); // checkout bounces back to the bag
    } finally {
      await pool.query('update inventory_level set on_hand = $2 where variant_id = $1', [
        v,
        before,
      ]);
      await page.goto('/cart');
      await page.getByRole('button', { name: /Remove Sample Oxford Shirt/ }).click();
    }
  });

  test('cart and checkout pages have no axe violations', async ({ page }) => {
    await addShirt(page, 'M');
    await page.goto('/cart');
    await axeClean(page);
    await page.goto('/checkout');
    await axeClean(page);
    await page.goto('/cart');
    await page.getByRole('button', { name: /Remove Sample Oxford Shirt/ }).click();
    await page.goto('/cart');
    await axeClean(page);
  });
});

test.describe('guest checkout (cash on delivery)', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.12' } });

  test('places a COD order: confirmed, stock sold, GST shown, email sent, bag emptied', async ({
    page,
  }) => {
    const email = `cod-${run}@example.test`;
    const v = await shirt('M');
    const stock0 = await onHand(v);
    await addShirt(page, 'M');
    await page.goto('/cart');
    await page.getByRole('link', { name: 'Secure checkout' }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByLabel('Order summary')).toContainText('[ RS. 1,499 ]');
    await fillCheckout(page, email);
    await place(page).click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-z]{16}\?t=/);
    await expect(page.getByRole('heading', { name: /ORDER #\d+/ })).toBeVisible();
    await expect(page.getByText('Confirmed').first()).toBeVisible();
    await expect(page.getByText('Cash on delivery').first()).toBeVisible();
    await expect(page.getByText(/keep \[ RS\. 1,499 \] ready/)).toBeVisible();
    await expect(page.getByText('GST included')).toBeVisible();
    await expect(page.locator('dd', { hasText: '[ RS. 71.38 ]' }).first()).toBeVisible(); // 5% of Rs 1,499, tax inclusive
    await expect(page.getByText('CGST', { exact: true })).toBeVisible();
    await expect(page.getByText('SGST', { exact: true })).toBeVisible();
    await expect(page.getByText('Order placed')).toBeVisible();
    await axeClean(page);

    const orders = await ordersFor(email);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'confirmed', total_paise: '149900' });
    expect(await onHand(v)).toBe(stock0 - 1);
    const mail = await waitForEmail(email, { subject: /received/ });
    expect(mail.text).toContain('Sample Oxford Shirt');

    // The bag is empty after ordering.
    await page.goto('/cart');
    await expect(page.getByText('Your bag is empty.')).toBeVisible();
    // The order page is private: without the secret it does not exist.
    const pid = orders[0]!.public_id;
    expect((await page.request.get(`/orders/${pid}`)).status()).toBe(404);
    expect((await page.request.get(`/orders/${pid}?t=wrong`)).status()).toBe(404);
  });

  test('a double submit (same checkout session) makes exactly one order', async ({ page }) => {
    const email = `double-${run}@example.test`;
    await addShirt(page, 'L');
    await page.goto('/checkout');
    await fillCheckout(page, email);
    await page.evaluate(() => {
      const f = document.querySelector('form[aria-label="Checkout"]') as HTMLFormElement;
      f.requestSubmit();
      f.requestSubmit();
    });
    await expect(page).toHaveURL(/\/orders\//);
    expect(await ordersFor(email)).toHaveLength(1);
  });

  test('INV-12: a price change after the page loaded stops checkout, shows the change and charges nothing', async ({
    page,
  }) => {
    const email = `price-${run}@example.test`;
    const v = await shirt('M');
    await addShirt(page, 'M');
    await page.goto('/checkout');
    await fillCheckout(page, email);
    await pool.query('update variant set price_paise = 159900 where id = $1', [v]);
    try {
      await place(page).click();
      const alert = page.locator('div[role=alert].sp-message');
      await expect(alert).toContainText('Your order changed');
      await expect(alert).toContainText('price changed from [ RS. 1,499 ] to [ RS. 1,599 ]');
      expect(await ordersFor(email)).toHaveLength(0);
      // The summary refreshes to the new price; confirming again succeeds at exactly that price.
      await expect(page.getByLabel('Order summary')).toContainText('[ RS. 1,599 ]');
      await place(page).click();
      await expect(page).toHaveURL(/\/orders\//);
      expect((await ordersFor(email))[0]!.total_paise).toBe('159900');
    } finally {
      await pool.query('update variant set price_paise = 149900 where id = $1', [v]);
    }
  });

  test('INV-12: stock that runs out after the page loaded is reported and nothing is created', async ({
    page,
  }) => {
    const email = `stock-${run}@example.test`;
    const v = await shirt('S');
    const before = await onHand(v);
    await addShirt(page, 'S');
    await page.goto('/checkout');
    await fillCheckout(page, email);
    await pool.query('update inventory_level set on_hand = 0 where variant_id = $1', [v]);
    try {
      await place(page).click();
      await expect(page.locator('div[role=alert].sp-message')).toContainText(/sold out|changed/i);
      expect(await ordersFor(email)).toHaveLength(0);
    } finally {
      await pool.query('update inventory_level set on_hand = $2 where variant_id = $1', [
        v,
        before,
      ]);
    }
  });

  test('field errors are shown next to the fields and nothing is created', async ({ page }) => {
    const email = `invalid-${run}@example.test`;
    await addShirt(page, 'M');
    await page.goto('/checkout');
    await fillCheckout(page, email);
    await page.getByLabel('Pincode').fill('123');
    await page.evaluate(() =>
      document.querySelector('form[aria-label="Checkout"]')?.setAttribute('novalidate', ''),
    );
    await place(page).click();
    await expect(page.getByText('Enter a valid 6-digit pincode')).toBeVisible();
    expect(await ordersFor(email)).toHaveLength(0);
  });
});

test.describe('online payment (against the fake Razorpay server)', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.13' } });

  async function startOnline(page: Page, email: string, size = 'M') {
    await addShirt(page, size);
    await page.goto('/checkout');
    await fillCheckout(page, email);
    await page.getByLabel(/Pay online/).check();
    await place(page).click();
    await expect(page).toHaveURL(/\/checkout\/pay\/[0-9a-z]{16}\?t=/);
    const url = new URL(page.url());
    const publicId = url.pathname.split('/').pop()!;
    const token = url.searchParams.get('t')!;
    const providerOrderId = (await scalar(
      'select p.provider_order_id from payment p join "order" o on o.id = p.order_id where o.public_id = $1',
      [publicId],
    )) as string;
    return { publicId, token, providerOrderId };
  }

  test('INV-02: a browser return never marks the order paid; only a verified provider capture does', async ({
    page,
  }) => {
    const email = `online-${run}@example.test`;
    const v = await shirt('M');
    const stock0 = await onHand(v);
    const { publicId, token, providerOrderId } = await startOnline(page, email);

    // The pay page shows the amount from the database and a pay button.
    await expect(page.getByRole('heading', { name: /PAYMENT/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Pay \[ RS\. 1,499 \]/ })).toBeVisible();
    const [order] = await ordersFor(email);
    expect(order!.status).toBe('pending_payment');
    expect(await onHand(v)).toBe(stock0); // held, not sold

    // 1) forged return signature: nothing changes, the page says it could not verify
    await page.goto(
      `/checkout/return?o=${publicId}&t=${token}&razorpay_order_id=${providerOrderId}&razorpay_payment_id=pay_forged&razorpay_signature=${'0'.repeat(64)}`,
    );
    await expect(page.getByText('We could not verify that payment response')).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    expect((await ordersFor(email))[0]!.status).toBe('pending_payment');

    // 2) correct signature but the provider has not captured the money: still pending
    const authorized = await (
      await fakeRzp('/__pay', {
        method: 'POST',
        body: JSON.stringify({ orderId: providerOrderId, status: 'authorized' }),
      })
    ).json();
    await page.goto(
      `/checkout/return?o=${publicId}&t=${token}&razorpay_order_id=${providerOrderId}&razorpay_payment_id=${authorized.id}&razorpay_signature=${returnSignature(providerOrderId, authorized.id)}`,
    );
    await expect(page.getByText(/still waiting for the bank/)).toBeVisible();
    expect((await ordersFor(email))[0]!.status).toBe('pending_payment');

    // 3) the provider captures the payment: the return check confirms the order
    const paid = await (
      await fakeRzp('/__pay', {
        method: 'POST',
        body: JSON.stringify({ orderId: providerOrderId }),
      })
    ).json();
    await page.goto(
      `/checkout/return?o=${publicId}&t=${token}&razorpay_order_id=${providerOrderId}&razorpay_payment_id=${paid.id}&razorpay_signature=${returnSignature(providerOrderId, paid.id)}`,
    );
    await expect(page.getByText('Confirmed').first()).toBeVisible();
    await expect(page.getByText('Paid').first()).toBeVisible();
    expect((await ordersFor(email))[0]!.status).toBe('confirmed');
    expect(await onHand(v)).toBe(stock0 - 1);
    await waitForEmail(email, { subject: /Payment received/ });
    // Nothing left to pay: the pay page now bounces to the order.
    await page.goto(`/checkout/pay/${publicId}?t=${token}`);
    await expect(page).toHaveURL(new RegExp(`/orders/${publicId}`));
  });

  test('the webhook endpoint: forged requests are refused, valid ones confirm, 5 replays change state once', async ({
    page,
    request,
  }) => {
    const email = `webhook-${run}@example.test`;
    const v = await shirt('L');
    const stock0 = await onHand(v);
    const { providerOrderId } = await startOnline(page, email, 'L');
    const pay = await (
      await fakeRzp('/__pay', {
        method: 'POST',
        body: JSON.stringify({ orderId: providerOrderId }),
      })
    ).json();
    const entity = { id: pay.id, order_id: providerOrderId, amount: pay.amount };

    const missing = signedWebhook('payment.captured', entity, 'evt_missing_sig');
    const noSig = await request.post('/api/webhooks/razorpay', {
      data: missing.body,
      headers: { 'content-type': 'application/json', 'x-razorpay-event-id': 'evt_missing_sig' },
    });
    expect(noSig.status()).toBe(400);
    const wrong = signedWebhook(
      'payment.captured',
      entity,
      'evt_wrong_sig',
      'someone-elses-secret',
    );
    expect(
      (
        await request.post('/api/webhooks/razorpay', { data: wrong.body, headers: wrong.headers })
      ).status(),
    ).toBe(400);
    const tampered = signedWebhook('payment.captured', entity, 'evt_tamper');
    expect(
      (
        await request.post('/api/webhooks/razorpay', {
          data: tampered.body.replace(String(pay.amount), '1'),
          headers: tampered.headers,
        })
      ).status(),
    ).toBe(400);
    expect((await ordersFor(email))[0]!.status).toBe('pending_payment');

    const good = signedWebhook('payment.captured', entity, `evt_good_${run}`);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push(
        (
          await request.post('/api/webhooks/razorpay', { data: good.body, headers: good.headers })
        ).status(),
      );
    expect(codes).toEqual([200, 200, 200, 200, 200]);
    expect((await ordersFor(email))[0]!.status).toBe('confirmed');
    expect(await onHand(v)).toBe(stock0 - 1); // sold exactly once
    expect(
      Number(
        await scalar('select count(*) from webhook_event where provider_event_id = $1', [
          `evt_good_${run}`,
        ]),
      ),
    ).toBe(1);
    expect(
      Number(
        await scalar(
          'select count(*) from order_event e join "order" o on o.id = e.order_id where o.email = $1 and e.type = \'order.confirm\'',
          [email],
        ),
      ),
    ).toBe(1);

    // A late "failed" notification for an old attempt cannot undo the payment.
    const late = signedWebhook(
      'payment.failed',
      { id: 'pay_old', order_id: providerOrderId, amount: pay.amount },
      `evt_late_fail_${run}`,
    );
    expect(
      (
        await request.post('/api/webhooks/razorpay', { data: late.body, headers: late.headers })
      ).status(),
    ).toBe(200);
    expect((await ordersFor(email))[0]!.status).toBe('confirmed');
    expect(
      await scalar(
        'select p.status from payment p join "order" o on o.id = p.order_id where o.email = $1',
        [email],
      ),
    ).toBe('captured');
  });
});

test.describe('customer account orders', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.14' } });
  const PASSWORD = 'a-perfectly-good-password';
  // Registering, reading the verification email and a whole checkout in one test is slow on a busy machine.
  test.setTimeout(120_000);

  async function signUp(page: Page, label: string) {
    const email = `${label}-${run}@example.test`;
    await page.goto('/register');
    await page.getByLabel('Full name').fill(`${label} Buyer`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible();
    const mail = await waitForEmail(email, { subject: /Verify your email/ });
    await page.goto(firstUrl(mail.text));
    await expect(page).toHaveURL(/\/account\?verified=1/);
    return email;
  }

  test('guest bag merges on sign-in; saved address checkout; order list, detail, cancel restores stock', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.15' },
    });
    const page = await ctx.newPage();
    const v = await shirt('M');
    // Guest fills the bag first.
    await addShirt(page, 'M');
    const email = await signUp(page, 'shopper');
    // After sign-in the guest bag is now the customer's bag.
    await page.goto('/cart');
    await expect(page.locator('li.sp-cart-line')).toHaveCount(1);

    // Save an address, then check out with it.
    await page.goto('/account/addresses?new=1');
    await page.getByLabel('Full name').fill('Asha Verma');
    await page.getByLabel('Address line 1').fill('99 Saved Road');
    await page.getByLabel('City').fill('Karnal');
    await page.getByLabel('State').selectOption('06');
    await page.getByLabel('Pincode').fill('132001');
    await page.getByLabel('Mobile number').fill('9876543211');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText(/99 Saved Road/)).toBeVisible(); // wait for the save before leaving

    await page.goto('/checkout');
    await expect(page.getByText(/99 Saved Road/)).toBeVisible();
    const stock0 = await onHand(v);
    await place(page).click();
    await expect(page).toHaveURL(/\/account\/orders\/[0-9a-z]{16}/);
    await expect(page.getByText('99 Saved Road')).toBeVisible();
    expect(await onHand(v)).toBe(stock0 - 1);

    // The list shows it; the detail shows a timeline; the customer can cancel before shipping.
    await page.goto('/account/orders');
    await expect(page.getByRole('link', { name: /^#\d+$/ })).toHaveCount(1);
    await page.getByRole('link', { name: /^#\d+$/ }).click();
    await expect(page.getByText('Order placed')).toBeVisible();
    await page.getByText('Cancel this order').click();
    await page.getByRole('button', { name: 'Yes, cancel my order' }).click();
    await expect(page.getByText('Your order has been cancelled.')).toBeVisible();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    expect(await onHand(v)).toBe(stock0); // stock restored
    await waitForEmail(email, { subject: /was cancelled/ });
    await ctx.close();
  });

  test('INV-13 over HTTP: another customer (or a guest) cannot open someone else order', async ({
    browser,
  }) => {
    const a = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.16' } });
    const b = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.17' } });
    const pa = await a.newPage();
    const pb = await b.newPage();
    const emailA = await signUp(pa, 'owner');
    await signUp(pb, 'snoop');

    await addShirt(pa, 'M');
    await pa.goto('/checkout');
    await pa.getByLabel('Mobile number').fill('9876543210');
    await pa.getByLabel('Full name').fill('Owner Buyer');
    await pa.getByLabel('Address line 1').fill('1 Private Lane');
    await pa.getByLabel('City').fill('Panipat');
    await pa.getByLabel('Pincode').fill('132103');
    await pa.getByLabel('Phone for the courier').fill('9876543210');
    await place(pa).click();
    await expect(pa).toHaveURL(/\/account\/orders\//);
    const publicId = pa.url().split('/').pop()!.split('?')[0]!;
    expect((await ordersFor(emailA)).length).toBe(1);

    for (const path of [
      `/account/orders/${publicId}`,
      `/orders/${publicId}`,
      `/orders/${publicId}?t=guess`,
      `/checkout/pay/${publicId}`,
    ]) {
      const res = await pb.request.get(path);
      expect(res.status(), path).toBe(404);
    }
    const anon = await browser.newContext();
    expect(
      (await anon.request.get(`/account/orders/${publicId}`, { maxRedirects: 0 })).status(),
    ).toBe(307); // sent to sign in
    await anon.close();
    // The owner can.
    expect((await pa.request.get(`/account/orders/${publicId}`)).status()).toBe(200);
    await a.close();
    await b.close();
  });
});

test.describe('rate limits (brief §9) and the newsletter form', () => {
  test('login: the 11th attempt in the window is refused with 429', async ({ request }) => {
    const headers = { origin: 'http://localhost:3100', 'x-forwarded-for': '203.0.113.99' };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await request.post('/api/auth/sign-in/email', {
        data: { email: `nobody-${run}@example.test`, password: 'wrong-password-123' },
        headers,
      });
      statuses.push(r.status());
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10)).toContain(429);
  });

  test('cart API: more than 120 requests a minute from one address are refused', async ({
    request,
  }) => {
    const headers = { origin: 'http://localhost:3100', 'x-forwarded-for': '203.0.113.98' };
    const v = await shirt('M');
    let limited = 0;
    for (let i = 0; i < 125; i++) {
      const r = await request.patch('/api/cart/items', { data: { variantId: v, qty: 0 }, headers });
      if (r.status() === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  test('newsletter sign-up stores the subscriber; bad phone numbers are rejected', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const form = page.locator('.dpm-newsletter-form');
    await form.getByPlaceholder('FIRST NAME').fill('Asha');
    await form.getByPlaceholder('EMAIL ADDRESS').fill(`news-${run}@example.test`);
    await form.getByPlaceholder('PHONE NUMBER').fill('12345');
    await form.getByRole('button', { name: 'WISHLIST ME NOW' }).click();
    await expect(form.getByRole('status')).toContainText('valid 10-digit mobile number');
    await form.getByPlaceholder('PHONE NUMBER').fill('+91 98765 43210');
    await form.getByRole('button', { name: 'WISHLIST ME NOW' }).click();
    await expect(form.getByRole('status')).toContainText('You are on the list');
    const rows = await q<{ phone: string }>(
      'select phone from newsletter_subscriber where email = $1',
      [`news-${run}@example.test`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe('9876543210');
  });
});

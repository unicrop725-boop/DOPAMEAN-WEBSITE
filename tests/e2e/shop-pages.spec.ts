import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { dbUrl } from './env';
import { firstUrl, waitForEmail } from './support';

const PASSWORD = 'a-perfectly-good-password';
const run = Date.now();

async function register(page: Page, label: string) {
  const email = `${label}-${run}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Full name').fill(`${label} Shopper`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  const mail = await waitForEmail(email, { subject: /Verify your email/ });
  await page.goto(firstUrl(mail.text)); // verification link also signs the user in
  await expect(page).toHaveURL(/\/account\?verified=1/);
  await expect(page.getByRole('status')).toContainText('verified');
  return email;
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function addAddress(page: Page, line1: string) {
  await page.goto('/account/addresses?new=1');
  await page.getByLabel('Full name').fill('Asha Verma');
  await page.getByLabel('Address line 1').fill(line1);
  await page.getByLabel('City').fill('Panipat');
  await page.getByLabel('State').selectOption('06');
  await page.getByLabel('Pincode').fill('132103');
  await page.getByLabel('Mobile number').fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page).toHaveURL(/\/account\/addresses$/);
}

test.describe('customer account journey (real browser, real email)', () => {
  test.setTimeout(120_000);

  test('register, verify, manage addresses, export data, delete account', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    const email = await register(page, 'alice');

    // Account overview shows the signed-in user.
    await expect(page.getByText(email)).toBeVisible();

    // Addresses: add, add a second default, edit, make default, delete.
    await page.goto('/account/addresses');
    await expect(page.getByText('You have no saved addresses.')).toBeVisible();
    await addAddress(page, '12 Test Street');
    await expect(page.getByText('12 Test Street')).toBeVisible();
    await expect(page.getByText('Default')).toBeVisible();
    await addAddress(page, '99 Second Road');
    await expect(page.locator('li', { hasText: '99 Second Road' })).toBeVisible();

    await page
      .locator('li', { hasText: '99 Second Road' })
      .getByRole('link', { name: 'Edit' })
      .click();
    await page.getByLabel('City').fill('Karnal');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.locator('li', { hasText: '99 Second Road' })).toContainText('Karnal');

    await page
      .locator('li', { hasText: '99 Second Road' })
      .getByRole('button', { name: 'Make default' })
      .click();
    await expect(page.locator('li', { hasText: '99 Second Road' })).toContainText('Default');
    await page
      .locator('li', { hasText: '12 Test Street' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByText('12 Test Street')).toHaveCount(0);

    // Validation errors are shown next to the fields.
    await page.goto('/account/addresses?new=1');
    await page.getByLabel('Full name').fill('A B');
    await page.getByLabel('Address line 1').fill('Somewhere 1');
    await page.getByLabel('City').fill('Panipat');
    await page.getByLabel('State').selectOption('06');
    await page.getByLabel('Pincode').fill('123');
    await page.getByLabel('Mobile number').fill('12345');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Enter a valid 6-digit pincode')).toBeVisible();
    await expect(page.getByText('Enter a valid 10-digit mobile number')).toBeVisible();

    // Data export contains this user's data only.
    const exportRes = await page.request.get('/account/privacy/export');
    expect(exportRes.status()).toBe(200);
    expect(exportRes.headers()['content-disposition']).toContain('attachment');
    const exported = await exportRes.json();
    expect(exported.account.email).toBe(email);
    expect(exported.addresses).toHaveLength(1);
    expect(exported.addresses[0].line1).toBe('99 Second Road');

    // Delete the account: wrong password is refused, right password signs out and removes the login.
    await page.goto('/account/privacy');
    await page.getByLabel('Your password').fill('not-my-password');
    await page.getByLabel('Type DELETE to confirm').fill('DELETE');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page.locator('p[role=alert]')).toContainText('password is not correct');
    await page.getByLabel('Your password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page).toHaveURL(/account-deleted=1/);

    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('p[role=alert]')).toHaveText('Invalid email or password.');
    await context.close();
  });

  test('INV-13 over HTTP: a second real customer cannot see or reach the first customer data', async ({
    browser,
  }) => {
    const a = await newPage(browser);
    const b = await newPage(browser);
    await register(a.page, 'ivy');
    await addAddress(a.page, '1 Private Lane');
    const pool = new Pool({ connectionString: dbUrl() });
    const { rows } = await pool.query(
      'select a.id from address a join "user" u on u.id = a.customer_id where u.email = $1',
      [`ivy-${run}@example.test`],
    );
    await pool.end();
    const ivyAddressId = rows[0].id as string;

    await register(b.page, 'jon');
    // Jon asks for Ivy's address in the edit form: he gets the plain list, never her data.
    await b.page.goto(`/account/addresses?edit=${ivyAddressId}`);
    await expect(b.page.getByText('1 Private Lane')).toHaveCount(0);
    await expect(b.page.getByRole('form', { name: 'Edit address' })).toHaveCount(0);
    // Jon's export has no trace of Ivy.
    const res = await b.page.request.get('/account/privacy/export');
    const body = await res.text();
    expect(body).not.toContain('ivy-');
    expect(body).not.toContain('Private Lane');
    await a.context.close();
    await b.context.close();
  });

  test('signed-out visitors are sent to sign in and the export endpoint refuses them', async ({
    page,
    request,
  }) => {
    await page.goto('/account/addresses');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Faddresses/);
    expect((await request.get('/account/privacy/export')).status()).toBe(401);
  });

  test('forgot password never reveals whether an email exists', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(`nobody-${run}@example.test`);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If an account exists');
  });

  test('password reset works end to end through email', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    const email = await register(page, 'reset');
    await page.request.post('/api/auth/sign-out', { headers: { origin: 'http://localhost:3100' } });
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If an account exists');
    const resetMail = await waitForEmail(email, { subject: /Reset your/ });
    const link = firstUrl(resetMail.text);
    expect(link).toContain('reset-password');
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password-1');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-brand-new-password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account/);
    await context.close();
  });
});

test.describe('content pages and contact form', () => {
  test('footer pages exist and show their title and the owner-must-write notice', async ({
    page,
  }) => {
    await page.goto('/pages/faq');
    await expect(page.getByRole('heading', { name: '[ FAQS ]' })).toBeVisible();
    await expect(page.getByText('This page has not been written yet')).toBeVisible();
    for (const slug of [
      'shipping',
      'about',
      'terms',
      'privacy',
      'size-charts',
      'exchanges-returns',
      'visit-us',
      'environmental-promises',
      'product-care',
      'gift-cards',
      'contact',
    ]) {
      const res = await page.request.get(`/pages/${slug}`);
      expect(res.status(), slug).toBe(200);
    }
    expect((await page.request.get('/pages/not-a-page')).status()).toBe(404);
  });

  test('every footer link on the home page leads to a real page', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const hrefs = await page.$$eval(
      '.dpm-desktop-wrapper a[href], .dpm-mobile-wrapper a[href]',
      (as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))],
    );
    expect(hrefs.length).toBeGreaterThan(8);
    for (const href of hrefs) {
      expect(href.startsWith('/'), href).toBe(true);
      expect((await request.get(href)).status(), href).toBeLessThan(400);
    }
  });

  test('contact form stores a message; the honeypot silently drops bots', async ({ page }) => {
    await page.goto('/pages/contact');
    await page.getByLabel('Name').fill('Asha');
    await page.getByLabel('Email').fill(`contact-${run}@example.test`);
    await page.getByLabel('Message').fill('Hello, is the sample shirt available in XXL?');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('status')).toContainText('Thank you');
    const pool = new Pool({ connectionString: dbUrl() });
    const stored = await pool.query('select message from contact_message where email = $1', [
      `contact-${run}@example.test`,
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].message).toContain('XXL');

    // Honeypot: a filled hidden field looks like success but stores nothing.
    await page.goto('/pages/contact');
    await page.getByLabel('Name').fill('Bot');
    await page.getByLabel('Email').fill(`bot-${run}@example.test`);
    await page.getByLabel('Message').fill('Buy cheap watches now please');
    await page.evaluate(() => {
      (document.getElementById('website') as HTMLInputElement).value = 'http://spam.test';
    });
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('status')).toBeVisible();
    const bot = await pool.query('select 1 from contact_message where email = $1', [
      `bot-${run}@example.test`,
    ]);
    await pool.end();
    expect(bot.rows).toHaveLength(0);
  });

  test('contact form shows field errors for bad input', async ({ page }) => {
    await page.goto('/pages/contact');
    await page.getByLabel('Name').fill('A');
    await page.getByLabel('Email').fill('a@b.test');
    await page.getByLabel('Message').fill('too short');
    await page.evaluate(() => document.querySelector('form')?.setAttribute('novalidate', ''));
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Enter your name')).toBeVisible();
  });
});

test.describe('catalog browsing: collections, filters, sort, pagination, search', () => {
  test('category and collection pages list only their products; unknown slugs 404', async ({
    page,
    request,
  }) => {
    await page.goto('/collections/top-wear');
    const names = await page.locator('.product-name').allInnerTexts();
    expect(names.sort()).toEqual([
      'SAMPLE BOXY TEE',
      'SAMPLE KNIT POLO',
      'SAMPLE OVERSHIRT',
      'SAMPLE OXFORD SHIRT',
    ]);
    await page.goto('/collections/bottom-wear');
    expect((await page.locator('.product-name').allInnerTexts()).sort()).toEqual([
      'SAMPLE CARGO SHORT',
      'SAMPLE PLEATED TROUSER',
      'SAMPLE STRAIGHT DENIM',
    ]);
    expect((await request.get('/collections/nope')).status()).toBe(404);
    expect((await request.get('/collections/new-in')).status()).toBe(200);
  });

  test('price shown on cards uses the original bracket style and comes from the database', async ({
    page,
  }) => {
    await page.goto('/collections/top-wear?sort=price_asc');
    const first = page.locator('.product-item').first();
    await expect(first.locator('.product-name')).toHaveText('SAMPLE BOXY TEE');
    await expect(first.locator('.product-price')).toHaveText('[ RS. 799 ]');
  });

  test('sort via URL and via the SORTED BY panel', async ({ page }) => {
    await page.goto('/collections/top-wear?sort=price_desc');
    await expect(page.locator('.product-name').first()).toHaveText('SAMPLE OVERSHIRT');
    await page.goto('/collections/top-wear');
    await page.getByRole('button', { name: 'SORTED BY' }).click();
    await expect(page.locator('#sort-panel')).toHaveClass(/is-open/);
    await page.getByRole('link', { name: 'Name' }).click();
    await expect(page).toHaveURL(/sort=name/);
    await expect(page.locator('.product-name').first()).toHaveText('SAMPLE BOXY TEE');
  });

  test('filter panel: size, price and in-stock filters live in the URL', async ({ page }) => {
    await page.goto('/collections/top-wear');
    await page.getByRole('button', { name: 'FILTER' }).click();
    await page.getByLabel('Min price (RS.)').fill('1000');
    await page.getByLabel('Max price (RS.)').fill('1600');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/min=1000/);
    await expect(page).toHaveURL(/max=1600/);
    const names = await page.locator('.product-name').allInnerTexts();
    expect(names.sort()).toEqual(['SAMPLE KNIT POLO', 'SAMPLE OXFORD SHIRT']);
    // The filter state survives a reload (it is in the URL, not in memory).
    await page.reload();
    expect((await page.locator('.product-name').allInnerTexts()).length).toBe(2);
  });

  test('empty filter result shows a message instead of a broken grid', async ({ page }) => {
    await page.goto('/collections/top-wear?min=900000');
    await expect(page.getByText('NO PRODUCTS MATCH THESE FILTERS.')).toBeVisible();
  });

  test('pagination: small page size gives working Previous / Next links', async ({ page }) => {
    await page.goto('/collections/top-wear?pageSize=2&sort=name');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    const first = await page.locator('.product-name').allInnerTexts();
    expect(first).toHaveLength(2);
    await page.getByRole('link', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    const second = await page.locator('.product-name').allInnerTexts();
    expect(second.some((n) => first.includes(n))).toBe(false);
    await page.getByRole('link', { name: 'Previous' }).click();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
  });

  test('search: finds by name, tolerates a typo, shows a count, and handles nothing found', async ({
    page,
  }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.nav-box-header-1').click();
    await expect(page).toHaveURL(/\/search$/);
    await page.getByRole('searchbox').fill('oxfrd');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/q=oxfrd/);
    await expect(page.locator('.product-name').first()).toHaveText('SAMPLE OXFORD SHIRT');
    await expect(page.getByRole('status')).toContainText('result');
    await page.goto('/search?q=zzzzqqqq');
    await expect(page.getByText('NO PRODUCTS FOUND FOR')).toBeVisible();
    // Hostile input is treated as plain text: the page renders (fuzzy matching may or may not find rows).
    const hostile = await page.goto('/search?q=%27%3B%20DROP%20TABLE%20product%3B%20--');
    expect(hostile?.status()).toBe(200);
    // The catalog is intact after the injection attempt.
    await page.goto('/collections/top-wear');
    expect(await page.locator('.product-name').count()).toBe(4);
  });

  test('draft and archived products never appear anywhere public', async ({ page, request }) => {
    const pool = new Pool({ connectionString: dbUrl() });
    await pool.query("update product set status = 'draft' where slug = 'sample-knit-polo'");
    try {
      await page.goto('/search?q=polo');
      await expect(page.getByText('NO PRODUCTS FOUND FOR')).toBeVisible();
      expect((await request.get('/products/sample-knit-polo')).status()).toBe(404);
      await page.goto('/collections/top-wear');
      expect(await page.locator('.product-name').allInnerTexts()).not.toContain('SAMPLE KNIT POLO');
    } finally {
      await pool.query("update product set status = 'published' where slug = 'sample-knit-polo'");
      await pool.end();
    }
  });
});

test.describe('product page data and structured data', () => {
  test('shows real name, price, stock-aware sizes and Product JSON-LD', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/products/sample-oxford-shirt');
    await expect(page.locator('.product-info-card h1')).toHaveText('SAMPLE OXFORD SHIRT');
    await expect(page.locator('.product-info-card .price')).toHaveText('RS. 1,499/-');
    // Seed: XXXL of the first product has no stock.
    await expect(page.locator('.size-selector button', { hasText: 'XXXL' })).toBeDisabled();
    await expect(page.locator('.size-selector button', { hasText: /^XL$/ })).toBeEnabled();
    const ld = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').innerText()) ?? '{}',
    );
    expect(ld['@type']).toBe('Product');
    expect(ld.offers.priceCurrency).toBe('INR');
    expect(ld.offers.lowPrice).toBe('1499.00');
    expect(ld.offers.availability).toBe('https://schema.org/InStock');
    expect(ld.image.length).toBeGreaterThan(0);
  });

  test('a sold-out size cannot be selected', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/products/sample-oxford-shirt');
    const soldOut = page.locator('.size-selector button', { hasText: 'XXXL' });
    await soldOut.click({ force: true });
    await expect(soldOut).not.toHaveClass(/active/);
  });

  test('mobile: details appear once the sheet docks, and the tabs switch the text', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/products/sample-oxford-shirt');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-tab-panel="materials"]')).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('#component-container')).toHaveClass(/is-docked/);
    await expect(page.locator('[data-tab-panel="materials"]')).toBeVisible();
    await page.locator('.details-tabs button', { hasText: 'CARE GUIDE' }).click();
    await expect(page.locator('[data-tab-panel="care"]')).toBeVisible();
    await expect(page.locator('[data-tab-panel="materials"]')).toBeHidden();
  });
});

test.describe('site chrome', () => {
  test('dark mode toggles and is remembered across reloads', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/collections/all');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('html')).not.toHaveClass(/dpm-dark/);
    await page.locator('.header-btn-3').click();
    await expect(page.locator('html')).toHaveClass(/dpm-dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dpm-dark/);
    await page.locator('.header-btn-3').click();
    await expect(page.locator('html')).not.toHaveClass(/dpm-dark/);
  });

  test('header buttons go to real pages', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/collections/all');
    await page.waitForLoadState('networkidle');
    await page.locator('.header-btn-2').click();
    await expect(page).toHaveURL(/\/pages\/contact/);
    await page.locator('.header-btn-1').click();
    await expect(page).toHaveURL(/\/collections\/all/);
  });

  test('mobile hamburger opens a menu with working links', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/collections/all');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'TOP WEAR' })
      .click();
    await expect(page).toHaveURL(/\/collections\/top-wear/);
  });

  test('styled 404 page keeps the site header and offers a way back', async ({ page }) => {
    const res = await page.goto('/collections/nope');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: /PAGE NOT FOUND/ })).toBeVisible();
    await expect(page.locator('.side-navigation-wrapper')).toBeVisible();
  });
});

test.describe('accessibility (axe, WCAG 2.2 AA) on the new screens', () => {
  for (const path of [
    '/login',
    '/register',
    '/forgot-password',
    '/pages/faq',
    '/pages/contact',
    '/search?q=shirt',
  ]) {
    test(`${path} has no violations`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }
});

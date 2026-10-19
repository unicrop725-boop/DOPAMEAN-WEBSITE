import { expect, test, type Page } from '@playwright/test';

/** Collect uncaught page errors and failed first-party requests (fonts 404 are a known, documented legacy issue). */
function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Catches React hydration warnings and other console errors, not only uncaught exceptions.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push(`console.error: ${m.text().slice(0, 200)}`);
    }
  });
  page.on('response', (r) => {
    const url = new URL(r.url());
    const isLegacyFont = /^\/css\/.*\.(woff2?|ttf)$/.test(url.pathname);
    if (r.status() >= 400 && url.hostname === 'localhost' && !isLegacyFont) {
      errors.push(`${r.status()} ${url.pathname}`);
    }
  });
  return errors;
}

test.describe('storefront pages load and behave', () => {
  test('home renders the original sections with no script or request errors', async ({ page }) => {
    const errors = watch(page);
    await page.goto('/');
    await expect(page).toHaveTitle('DOPAMEAN | Responsive Page');
    await expect(page.getByText('UNLEASH YOUR STYLE: DISCOVER THE LATEST TRENDS')).toBeVisible();
    await expect(page.locator('.product-card')).toHaveCount(4);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('home: the shopping bag drawer opens and closes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const errors = watch(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const bag = page.locator('.shopping-bag-container');
    await expect(bag).not.toHaveClass(/is-visible/);
    await page.locator('#open-bag-link').click();
    await expect(bag).toHaveClass(/is-visible/);
    await page.locator('#close-bag-btn').click();
    await expect(bag).not.toHaveClass(/is-visible/);
    expect(errors).toEqual([]);
  });

  test('mobile footer accordion expands one section at a time', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const items = page.locator('.dpm-accordion-item');
    const first = items.nth(1);
    const second = items.nth(2);
    await first.locator('.dpm-accordion-header').click();
    await expect(first).toHaveClass(/is-open/);
    await second.locator('.dpm-accordion-header').click();
    await expect(second).toHaveClass(/is-open/);
    await expect(first).not.toHaveClass(/is-open/);
  });

  test('collection page loads with its product grid', async ({ page }) => {
    const errors = watch(page);
    await page.goto('/collections/all');
    await expect(page).toHaveTitle('Shop all | DOPAMEAN');
    await expect(page.locator('.product-item').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('product page: size selection, size guide modal and accordion work', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const errors = watch(page);
    await page.goto('/products/sample-oxford-shirt');
    await page.waitForLoadState('networkidle');

    const sizes = page.locator('.size-selector button');
    await sizes.filter({ hasText: /^XL$/ }).click();
    await expect(sizes.filter({ hasText: /^XL$/ })).toHaveClass(/active/);
    await expect(sizes.filter({ hasText: /^L$/ })).not.toHaveClass(/active/);

    await page.locator('#size-guide-link').click();
    await expect(page.locator('#size-guide-modal')).toHaveClass(/visible/);
    await page.locator('#modal-close-button').click();
    await expect(page.locator('#size-guide-modal')).not.toHaveClass(/visible/);

    const items = page.locator('.accordion-item');
    await items.nth(1).locator('.accordion-header').click();
    await expect(items.nth(1)).toHaveClass(/active/);
    await expect(items.nth(0)).not.toHaveClass(/active/);
    await items.nth(1).locator('.accordion-header').click();
    await expect(items.nth(1)).not.toHaveClass(/active/);
    expect(errors).toEqual([]);
  });

  test('unknown product slugs return 404 (the route checks the database)', async ({ request }) => {
    const res = await request.get('/products/does-not-exist');
    expect(res.status()).toBe(404);
  });
});

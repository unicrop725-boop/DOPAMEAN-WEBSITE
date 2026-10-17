import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { dbUrl } from './env';

const pool = new Pool({ connectionString: dbUrl(), max: 2 });
test.afterAll(async () => {
  await pool.end();
});

const KEY = `banners/${'a'.repeat(32)}.webp`;

test.describe('storefront banners and site icon', () => {
  test.afterEach(async () => {
    await pool.query('delete from site_banner');
    await pool.query("delete from store_setting where key = 'brand'");
  });

  test('an active banner appears after the first product row; hidden ones do not; without banners nothing is added', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/collections/all');
    await expect(page.locator('.sp-ad-banner')).toHaveCount(0);

    await pool.query(
      `insert into site_banner (object_key, alt, link_url, width, height, position, active) values
       ($1, 'Visible promo', '/collections/new-in', 2400, 600, 0, true),
       ($1, 'Hidden promo', null, 2400, 600, 1, false)`,
      [KEY],
    );
    await page.goto('/collections/all');
    const banner = page.locator('.sp-ad-banner');
    await expect(banner).toHaveCount(1);
    await expect(banner.locator('img')).toHaveAttribute('alt', 'Visible promo');
    await expect(banner.locator('img')).toHaveAttribute('src', `/media/${KEY}`);
    await expect(banner.locator('a')).toHaveAttribute('href', '/collections/new-in');

    // It sits between the first row of products and the second row.
    const order = await page.evaluate(() => {
      const kids = [...document.querySelectorAll('.product-grid, .sp-ad-banner')];
      return kids.map((k) => (k.classList.contains('sp-ad-banner') ? 'banner' : 'grid'));
    });
    expect(order.slice(0, 3)).toEqual(['grid', 'banner', 'grid']);
    await expect(page.getByText('Hidden promo')).toHaveCount(0);
  });

  test('the site icon is the built-in one until a custom icon is set', async ({ page }) => {
    await page.goto('/collections/all');
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute(
      'href',
      '/favicon.png',
    );
    await pool.query(
      `insert into store_setting (key, value) values ('brand', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ faviconKey: `site/${'b'.repeat(32)}.webp` })],
    );
    await page.goto('/collections/all');
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute(
      'href',
      `/media/site/${'b'.repeat(32)}.webp`,
    );
  });

  test('/media only serves keys the app created: odd keys are 404, never a listing or a file', async ({
    request,
  }) => {
    for (const path of [
      '/media/products/abc.webp',
      '/media/..%2f.env',
      '/media/banners/%2e%2e/secret',
      '/media/other/' + 'c'.repeat(32) + '.webp',
      '/media/products/' + 'd'.repeat(32) + '.png',
    ]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
    // A well-formed key that does not exist is also a plain 404.
    expect((await request.get(`/media/${KEY}`)).status()).toBe(404);
  });
});

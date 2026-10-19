import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { OWNER, dbUrl } from './env';
import { firstUrl, secretFromUri, totp, waitForEmail } from './support';

test.describe('health and headers', () => {
  test('health endpoint reports database and worker ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.worker.ok).toBe(true);
  });

  test('security headers are set, including a CSP without framing', async ({ request }) => {
    const res = await request.get('/admin/login');
    const h = res.headers();
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toContain("object-src 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBeTruthy();
    expect(h['x-powered-by']).toBeUndefined();
  });
});

test.describe('admin access control', () => {
  test('signed-out visitors are redirected to the login page', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('login page has no axe violations', async ({ page }) => {
    await page.goto('/admin/login');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('wrong password shows a generic error', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('p[role=alert]')).toHaveText('Invalid email or password.');
  });

  test('owner must enrol TOTP 2FA, then reaches the dashboard with real data', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // 2FA is mandatory for Owner: every admin page redirects here until enrolled.
    await expect(page).toHaveURL(/\/admin\/security/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/security/);

    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    const uri = await page.getByRole('link', { name: /^otpauth:/ }).innerText();
    await page.getByRole('textbox', { name: 'Code' }).fill(totp(secretFromUri(uri)));
    await page.getByRole('button', { name: 'Verify and enable' }).click();

    await expect(page).toHaveURL(/\/admin$/);
    // The tile is computed from the database; cross-check it against a direct count.
    const pool = new Pool({ connectionString: dbUrl() });
    const { rows } = await pool.query(
      "select count(*)::int as n from product where status = 'published'",
    );
    await pool.end();
    const tile = page
      .locator('div', { has: page.getByText('Published products', { exact: true }) })
      .last();
    await expect(tile.locator('dd')).toHaveText(String(rows[0].n));
    await expect(page.getByText(/owner@example\.test · owner/)).toBeVisible();
  });
});

test.describe('customer sign-up goes through the outbox and worker', () => {
  const email = `shopper-${Date.now()}@example.test`;
  const password = 'a-perfectly-good-password';

  test('verification email is delivered, sign-in is blocked until verified, customers are not staff', async ({
    page,
    request,
  }) => {
    const signUp = await request.post('/api/auth/sign-up/email', {
      data: { name: 'Shopper', email, password },
      headers: { origin: 'http://localhost:3100' },
    });
    expect(signUp.ok()).toBe(true);

    // Not verified yet: sign-in refused (requireEmailVerification).
    const early = await request.post('/api/auth/sign-in/email', {
      data: { email, password },
      headers: { origin: 'http://localhost:3100' },
    });
    expect(early.status()).toBe(403);

    // Email arrives via outbox -> worker -> SMTP (Mailpit).
    const mail = await waitForEmail(email);
    expect(mail.subject).toMatch(/Verify your email/);
    const link = firstUrl(mail.text);
    const verified = await request.get(link);
    expect(verified.ok()).toBe(true);

    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Signed in as a customer, but admin still refuses: no staff profile.
    await expect(page).toHaveURL(/\/admin\/login\?error=not-staff/);
    await expect(page.locator('p[role=alert]')).toContainText('does not have admin access');
  });
});

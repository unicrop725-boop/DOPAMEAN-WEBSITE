import type { Page } from '@playwright/test';

export const WIDTHS = [375, 768, 1280, 1920] as const;
export const HEIGHT = 900;

/**
 * Deterministic full-page screenshot: frozen clock (the pages show a live clock), animations off,
 * video masked (autoplay frame is timing dependent).
 */
export async function shoot(
  page: Page,
  url: string,
  width: number,
  maskSelectors: string[] = [],
): Promise<Buffer> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.clock.install({ time: new Date('2026-01-01T10:00:00+05:30') });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('video'), ...maskSelectors.map((sel) => page.locator(sel))],
  });
}

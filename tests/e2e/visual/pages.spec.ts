import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { E2E_PORT } from '../env';
import { serveLegacy } from './static-server';
import { WIDTHS, shoot } from './shots';

/**
 * Design preservation proof (ADR 0001/0004): render the ORIGINAL static page from legacy/ and the
 * ported Next page at the same width, same frozen clock, and require the screenshots to match.
 * Differences are written to test-results/visual-diff for inspection.
 */
const LEGACY_PORT = 4173;
const MAX_DIFF_RATIO = Number(process.env.VISUAL_MAX_DIFF_RATIO ?? 0.0005); // 0.05% of pixels

type PageCase = {
  name: string;
  legacy: string;
  app: string;
  widths: readonly number[];
  /** Elements whose TEXT intentionally differs because the original shows inconsistent hard-coded copy. */
  mask?: string[];
};

const PAGES: PageCase[] = [
  { name: 'home', legacy: 'index.html', app: '/', widths: WIDTHS },
  // Data comes from scripts/seed-parity.ts, which reproduces the original grid from legacy/collection_page.html.
  {
    name: 'collection',
    legacy: 'collection_page.html',
    app: '/collections/showcase',
    widths: WIDTHS,
  },
  {
    // The original product page repeats three different hard-coded prices and two different model-info lines;
    // one database value cannot match all of them, so those text boxes are masked. Its mobile gallery shows 3
    // images while the desktop one shows 5; a real product has one image list, so mobile widths are covered
    // by the structural tests instead of a pixel comparison.
    name: 'product',
    legacy: 'products.html',
    app: '/products/parity-product',
    widths: [1280, 1920],
    mask: [
      '.add-to-bag-btn-price',
      '.price',
      '.final-price',
      '.model-info',
      '.model-info-mobile',
      '.thumbnail-gallery',
    ],
  },
];

let server: Server;
test.beforeAll(async () => {
  server = await serveLegacy(LEGACY_PORT);
});
test.afterAll(() => {
  server.close();
});

test.describe('ported pages look identical to the original static pages', () => {
  test.setTimeout(120_000);
  for (const p of PAGES) {
    for (const width of p.widths) {
      test(`${p.name} @ ${width}px`, async ({ browser }) => {
        const a = await browser.newPage();
        const b = await browser.newPage();
        try {
          const original = PNG.sync.read(
            await shoot(a, `http://127.0.0.1:${LEGACY_PORT}/${p.legacy}`, width, p.mask),
          );
          const ported = PNG.sync.read(
            await shoot(b, `http://localhost:${E2E_PORT}${p.app}`, width, p.mask),
          );

          expect(
            { w: ported.width, h: ported.height },
            'page dimensions differ from the original',
          ).toEqual({ w: original.width, h: original.height });

          const diff = new PNG({ width: original.width, height: original.height });
          const changed = pixelmatch(
            original.data,
            ported.data,
            diff.data,
            original.width,
            original.height,
            {
              threshold: 0.1,
            },
          );
          const ratio = changed / (original.width * original.height);
          if (ratio > MAX_DIFF_RATIO) {
            const dir = join('test-results', 'visual-diff');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${p.name}-${width}-diff.png`), PNG.sync.write(diff));
          }
          expect(ratio, `${changed} pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
        } finally {
          await a.close();
          await b.close();
        }
      });
    }
  }
});

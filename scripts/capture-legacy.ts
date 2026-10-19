// One-off helper: render the original static pages and save PNGs to a directory (default: ./.legacy-shots).
//   npx tsx scripts/capture-legacy.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serveLegacy } from '../tests/e2e/visual/static-server';
import { WIDTHS, shoot } from '../tests/e2e/visual/shots';

const PAGES = ['index', 'collection_page', 'products'] as const;

async function main() {
  const out = resolve(process.argv[2] ?? '.legacy-shots');
  mkdirSync(out, { recursive: true });
  const server = await serveLegacy(4173);
  const browser = await chromium.launch();
  try {
    for (const name of PAGES) {
      for (const w of WIDTHS) {
        const page = await browser.newPage();
        const failed: string[] = [];
        page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
        const png = await shoot(page, `http://127.0.0.1:4173/${name}.html`, w);
        writeFileSync(join(out, `${name}-${w}.png`), png);
        console.log(
          name,
          w,
          `${(png.length / 1024).toFixed(0)}KB`,
          failed.length ? `FAILED: ${[...new Set(failed)].join(', ')}` : '',
        );
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

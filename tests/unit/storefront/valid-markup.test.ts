import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = 'src/storefront';
const files = readdirSync(DIR).filter((f) => f.endsWith('.tsx'));

describe('generated storefront markup is valid for React hydration', () => {
  it('has generated files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`${file}: no whitespace text directly inside table structure or select`, () => {
      const src = readFileSync(join(DIR, file), 'utf8');
      // A whitespace text node ({' '} / {" "}) right after an opening, or right before a closing,
      // table/thead/tbody/tfoot/tr/select tag triggers a React hydration error.
      const bad =
        /<(table|thead|tbody|tfoot|tr|colgroup|select)\b[^>]*>\s*\{\s*['"] ['"]\s*\}|\{\s*['"] ['"]\s*\}\s*<\/(table|thead|tbody|tfoot|tr|colgroup|select)>/g;
      expect(src.match(bad)).toBeNull();
    });
  }
});

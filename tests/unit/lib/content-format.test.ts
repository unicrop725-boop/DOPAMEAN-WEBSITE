import { describe, expect, it } from 'vitest';
import { parseContent } from '@/lib/content-format';
import { safeNext } from '@/lib/safe-redirect';

describe('parseContent (plain text only, never HTML)', () => {
  it('splits paragraphs, headings and lists', () => {
    const blocks = parseContent(
      'Intro line one\nstill intro\n\n## Heading\n\n- one\n- two\n\nLast',
    );
    expect(blocks).toEqual([
      { type: 'p', text: 'Intro line one still intro' },
      { type: 'h2', text: 'Heading' },
      { type: 'ul', items: ['one', 'two'] },
      { type: 'p', text: 'Last' },
    ]);
  });

  it('keeps markup as inert text so React escapes it', () => {
    const [block] = parseContent('<script>alert(1)</script>');
    expect(block).toEqual({ type: 'p', text: '<script>alert(1)</script>' });
  });

  it('handles Windows newlines and empty input', () => {
    expect(parseContent('a\r\n\r\nb')).toHaveLength(2);
    expect(parseContent('')).toEqual([]);
    expect(parseContent('\n\n\n')).toEqual([]);
  });
});

describe('safeNext (open-redirect protection)', () => {
  it('allows same-site paths', () => {
    expect(safeNext('/account/orders')).toBe('/account/orders');
    expect(safeNext('/collections/all?sort=name')).toBe('/collections/all?sort=name');
  });

  it('rejects absolute, protocol-relative and backslash URLs', () => {
    for (const bad of [
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      'javascript:alert(1)',
      'account',
    ]) {
      expect(safeNext(bad), bad).toBe('/account');
    }
  });

  it('falls back when missing and uses the first array value', () => {
    expect(safeNext(undefined)).toBe('/account');
    expect(safeNext(['/a', '/b'])).toBe('/a');
    expect(safeNext(undefined, '/x')).toBe('/x');
  });
});

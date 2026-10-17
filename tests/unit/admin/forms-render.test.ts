import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import {
  ActionForm,
  Field,
  FormContext,
  FormMessage,
  SubmitButton,
} from '@/components/admin/forms';
import { Forbidden, Metric, Pagination, Rupees } from '@/components/admin/parts';
import type { ActionState } from '@/lib/action-result';

type N = { type: string; name?: string; attribs?: Record<string, string>; children?: N[] };

/** Tiny selector: `tag`, `tag[attr]`, `tag[attr="v"]`, `[attr="v"]`, `#id` or a comma list of those. */
function matches(n: N, selector: string): boolean {
  return selector.split(',').some((raw) => {
    const sel = raw.trim();
    const m = /^([a-z0-9]*)(?:#([^[\s]+))?(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/i.exec(sel);
    if (!m || n.type !== 'tag') return false;
    const [, tag, id, a, v] = m;
    if (tag && n.name !== tag) return false;
    if (id && n.attribs?.id !== id) return false;
    if (a) {
      if (!(a in (n.attribs ?? {}))) return false;
      if (v !== undefined && n.attribs?.[a] !== v) return false;
    }
    return true;
  });
}
function selectAll(selector: string, root: unknown): N[] {
  const out: N[] = [];
  const walk = (n: N) => {
    if (matches(n, selector)) out.push(n);
    n.children?.forEach(walk);
  };
  walk(root as N);
  return out;
}
function textOf(n: unknown): string {
  const node = n as { type: string; data?: string; children?: unknown[] } | null;
  if (!node) return '';
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? []).map(textOf).join('');
}
const selectOne = (selector: string, root: unknown): N | null =>
  selectAll(selector, root)[0] ?? null;

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  parseDocument(renderToStaticMarkup(el));
const attr = (node: unknown, name: string) =>
  (node as { attribs?: Record<string, string> }).attribs?.[name];

function withState(state: ActionState, ...children: Parameters<typeof h>[2][]) {
  return h(FormContext.Provider, { value: { state, pending: false } }, ...children);
}

describe('admin form fields are labelled and announce their errors', () => {
  it('every control has a label bound by id, required marker and hint wiring', () => {
    const doc = html(
      h(
        ActionForm,
        { action: async () => ({ ok: true }), 'aria-label': 'Test form', children: null },
        h(Field, { name: 'name', label: 'Name', required: true, hint: 'Shown to customers' }),
        h(Field, { name: 'about', label: 'About', kind: 'textarea' }),
        h(Field, {
          name: 'kind',
          label: 'Kind',
          kind: 'select',
          options: [{ value: 'a', label: 'A' }],
        }),
        h(Field, { name: 'on', label: 'Switch', kind: 'checkbox', defaultValue: true }),
        h(SubmitButton, null, 'Save'),
      ),
    );
    const controls = selectAll('input, textarea, select', doc);
    expect(controls).toHaveLength(4);
    for (const control of controls) {
      const id = attr(control, 'id');
      expect(id, 'control has an id').toBeTruthy();
      const label = selectOne(`label[for="${id}"]`, doc);
      expect(label, `label for ${attr(control, 'name')}`).toBeTruthy();
    }
    const name = selectOne('input[name="name"]', doc)!;
    expect(attr(name, 'required')).toBeDefined();
    expect(
      selectOne(`#${attr(name, 'aria-describedby')}`.replaceAll(':', '\\:'), doc),
    ).toBeTruthy();
    expect(attr(selectOne('input[name="on"]', doc)!, 'checked')).toBeDefined();
    expect(selectOne('button[type="submit"]', doc)).toBeTruthy();
    expect(selectOne('form[aria-label="Test form"]', doc)).toBeTruthy();
  });

  it('shows a field error with aria-invalid and keeps what the user typed after a failed submit', () => {
    const doc = html(
      withState(
        {
          ok: false,
          message: 'Please fix the highlighted fields.',
          fieldErrors: { sku: 'This SKU is already in use' },
          values: { sku: 'TEE-1', note: 'kept' },
        },
        h(Field, { name: 'sku', label: 'SKU', defaultValue: 'old' }),
        h(Field, { name: 'note', label: 'Note', kind: 'textarea' }),
        h(FormMessage, null),
      ),
    );
    const sku = selectOne('input[name="sku"]', doc)!;
    expect(attr(sku, 'aria-invalid')).toBe('true');
    expect(attr(sku, 'value')).toBe('TEE-1'); // not the server default
    const errId = attr(sku, 'aria-describedby')!;
    const err = selectOne(`[id="${errId}"]`, doc)!;
    expect(textOf(err)).toContain('This SKU is already in use');
    expect(textOf(selectOne('textarea[name="note"]', doc))).toContain('kept');
    const alert = selectOne('[role="alert"]', doc)!;
    expect(textOf(alert)).toContain('Please fix the highlighted fields.');
  });

  it('announces success politely and never renders an alert for it', () => {
    const doc = html(withState({ ok: true, message: 'Saved.' }, h(FormMessage, null)));
    expect(selectOne('[role="alert"]', doc)).toBeNull();
    expect(textOf(selectOne('[role="status"]', doc))).toContain('Saved.');
  });

  it('an unchecked box stays unchecked after a failed submit', () => {
    const doc = html(
      withState(
        { ok: false, values: { other: 'x' } },
        h(Field, { name: 'published', label: 'Published', kind: 'checkbox', defaultValue: true }),
      ),
    );
    expect(attr(selectOne('input[name="published"]', doc)!, 'checked')).toBeUndefined();
  });
});

describe('admin page parts', () => {
  it('Forbidden is an alert with a way out, for both reasons', () => {
    for (const reason of ['FORBIDDEN', 'TWO_FACTOR_REQUIRED'] as const) {
      const doc = html(h(Forbidden, { what: 'refunds', reason }));
      expect(selectOne('[role="alert"]', doc)).toBeTruthy();
      expect(selectOne('h1', doc)).toBeTruthy();
      expect(selectOne('a[href="/admin"]', doc)).toBeTruthy();
    }
  });

  it('Pagination exposes a labelled nav and disables the ends', () => {
    const doc = html(
      h(Pagination, {
        page: 1,
        pageCount: 3,
        total: 120,
        pageSize: 50,
        hrefFor: (p) => `/x?page=${p}`,
      }),
    );
    expect(selectOne('nav[aria-label="Pagination"]', doc)).toBeTruthy();
    expect(selectOne('a[href="/x?page=2"]', doc)).toBeTruthy();
    expect(selectOne('a[href="/x?page=0"]', doc)).toBeNull();
    expect(selectOne('span[aria-disabled="true"]', doc)).toBeTruthy();
    expect(
      renderToStaticMarkup(
        h(Pagination, { page: 1, pageCount: 1, total: 0, pageSize: 50, hrefFor: () => '' }),
      ),
    ).toContain('No results');
  });

  it('Metric keeps one term and one value per tile with the definition inside the term', () => {
    const doc = html(
      h(
        'dl',
        null,
        h(Metric, {
          label: 'Orders today',
          value: 4,
          definition: 'Orders today: counted since midnight.',
        }),
      ),
    );
    expect(selectAll('dt', doc)).toHaveLength(1);
    expect(selectAll('dd', doc)).toHaveLength(1);
    expect(textOf(selectOne('dt', doc))).toContain('counted since midnight');
  });

  it('money is shown as Indian-grouped rupees from integer paise', () => {
    expect(renderToStaticMarkup(h(Rupees, { paise: 149_900 }))).toContain('Rs. 1,499');
    expect(renderToStaticMarkup(h(Rupees, { paise: 12_345_650 }))).toContain('Rs. 1,23,456.50');
    expect(renderToStaticMarkup(h(Rupees, { paise: 5 }))).toContain('Rs. 0.05');
  });
});

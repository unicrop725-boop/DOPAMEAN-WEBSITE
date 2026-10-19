// One-time converter: original static HTML body -> React (TSX) component, 1:1.
//   npx tsx scripts/port-page.ts legacy/index.html src/storefront/home.tsx HomeMarkup
// Keeps element order, class names, attributes and text; drops comments and <script> tags.
// Whitespace between elements is preserved as real text nodes so inline layout is identical.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';

const [, , input, output, componentName = 'Markup'] = process.argv;
if (!input || !output) throw new Error('usage: port-page.ts <input.html> <output.tsx> [Name]');

const VOID = new Set(['img', 'input', 'br', 'hr', 'link', 'meta', 'source', 'area', 'col', 'wbr']);
const RENAME: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  crossorigin: 'crossOrigin',
  srcset: 'srcSet',
  autoplay: 'autoPlay',
  playsinline: 'playsInline',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  novalidate: 'noValidate',
  frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  viewbox: 'viewBox',
};
const BOOLEAN = new Set([
  'required',
  'autoplay',
  'muted',
  'loop',
  'controls',
  'disabled',
  'checked',
  'selected',
  'readonly',
  'playsinline',
  'hidden',
]);

// Page links in the original point at sibling .html files; map them to the app routes.
const HREF_MAP: Record<string, string> = {
  'index.html': '/',
  './index.html': '/',
  'collection_page.html': '/collections/all',
  './collection_page.html': '/collections/all',
  'products.html': '/products/sample-oxford-shirt',
  './products.html': '/products/sample-oxford-shirt',
};

// Links that were href="#" (or pointed at the wrong sibling page) in the original are wired by their
// visible text. Anchors whose text is not listed keep their original href.
const TEXT_LINKS: Record<string, string> = {
  'shop all': '/collections/all',
  apparel: '/collections/all',
  'top wear': '/collections/top-wear',
  'bottom wear': '/collections/bottom-wear',
  'new in': '/collections/new-in',
  account: '/account',
  faqs: '/pages/faq',
  faq: '/pages/faq',
  'product care': '/pages/product-care',
  'size charts': '/pages/size-charts',
  orders: '/account/orders',
  shipping: '/pages/shipping',
  'shipping & returns': '/pages/shipping',
  'exchanges/returns': '/pages/exchanges-returns',
  'gift cards': '/pages/gift-cards',
  about: '/pages/about',
  'our story': '/pages/about',
  contact: '/pages/contact',
  'contact us': '/pages/contact',
  'visit us': '/pages/visit-us',
  'environmental promises': '/pages/environmental-promises',
  'terms of service': '/pages/terms',
  'privacy policy': '/pages/privacy',
  'contunie shopping': '/collections/all',
  'continue shopping': '/collections/all',
};
// Social links have no URL yet (owner input needed): keep them as non-link text rather than dead links.
const NO_URL_YET = new Set([
  'instagram',
  'youtube',
  'pintrest',
  'pinterest',
  'linkedin',
  'facebook',
]);

function textOf(el: Element): string {
  const walk = (n: ChildNode): string =>
    n.type === 'text'
      ? (n as unknown as { data: string }).data
      : n.type === 'tag'
        ? (n as Element).children.map(walk).join('')
        : '';
  return el.children.map(walk).join('').replace(/\s+/g, ' ').trim().toLowerCase();
}

function camel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function styleObject(css: string): string {
  const entries = css
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':');
      const k = d.slice(0, i).trim();
      // Inline url(./assets/..) is relative to the old page location; make it root-relative.
      const v = d
        .slice(i + 1)
        .trim()
        .replace(/url\((['"]?)\.\//g, 'url($1/');
      return `${JSON.stringify(camel(k))}: ${JSON.stringify(v)}`;
    });
  return `{{ ${entries.join(', ')} }}`;
}

function rewriteUrl(value: string): string {
  if (HREF_MAP[value]) return HREF_MAP[value];
  // ./assets/x.png -> /assets/x.png ; ./css/.. ; ./script/..
  if (value.startsWith('./')) return value.slice(1);
  return value;
}

function attrs(el: Element): string {
  const out: string[] = [];
  for (const [rawName, rawValue] of Object.entries(el.attribs)) {
    const name = rawName.toLowerCase();
    const jsx = RENAME[name] ?? rawName;
    if (name === 'style') {
      out.push(`style=${styleObject(rawValue)}`);
      continue;
    }
    if (BOOLEAN.has(name) && (rawValue === '' || rawValue === name)) {
      out.push(jsx);
      continue;
    }
    let value = rawValue;
    if (name === 'href' && el.name === 'a') {
      const label = textOf(el);
      if (NO_URL_YET.has(label)) continue;
      const mapped = TEXT_LINKS[label];
      if (mapped) {
        out.push(`href=${JSON.stringify(mapped)}`);
        continue;
      }
    }
    if (name === 'href' || name === 'src') value = rewriteUrl(value);
    // `value`/`checked` on inputs without handlers would turn into controlled inputs; use defaults.
    const isButtonInput =
      el.name === 'input' && ['submit', 'button', 'reset'].includes(el.attribs.type ?? '');
    const final = name === 'value' && el.name === 'input' && !isButtonInput ? 'defaultValue' : jsx;
    out.push(`${final}=${JSON.stringify(value)}`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

function textNode(data: string): string {
  const collapsed = data.replace(/\s+/g, ' ');
  return `{${JSON.stringify(collapsed)}}`;
}

// Whitespace between these elements' children is not rendered by browsers, and React rejects it
// (hydration error), so whitespace-only text is dropped there.
const NO_TEXT_CHILDREN = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'select',
  'optgroup',
  'datalist',
]);

function render(node: ChildNode, parent?: Element): string {
  if (node.type === 'text') {
    const data = (node as unknown as { data: string }).data;
    if (parent && NO_TEXT_CHILDREN.has(parent.name) && data.trim() === '') return '';
    return textNode(data);
  }
  if (node.type !== 'tag') return ''; // comments, directives
  const el = node as Element;
  if (el.name === 'script') return '';
  const a = attrs(el);
  if (VOID.has(el.name)) return `<${el.name}${a} />`;
  const children = el.children.map((c) => render(c, el)).join('');
  return `<${el.name}${a}>${children}</${el.name}>`;
}

const doc = parseDocument(readFileSync(input, 'utf8'));
function findBody(nodes: ChildNode[]): Element | undefined {
  for (const n of nodes) {
    if (n.type === 'tag') {
      if ((n as Element).name === 'body') return n as Element;
      const found = findBody((n as Element).children);
      if (found) return found;
    }
  }
  return undefined;
}
const body = findBody(doc.children);
if (!body) throw new Error('no <body> found');

const jsx = body.children.map((c) => render(c)).join('');
const banner = `// GENERATED by scripts/port-page.ts from ${input}. Markup is a 1:1 port of the original page;\n// edit data bindings by hand after generation, not the structure.\n/* eslint-disable */\n`;
writeFileSync(output, `${banner}export function ${componentName}() {\n  return <>${jsx}</>;\n}\n`);
console.log(`wrote ${output} (${jsx.length} chars of JSX)`);

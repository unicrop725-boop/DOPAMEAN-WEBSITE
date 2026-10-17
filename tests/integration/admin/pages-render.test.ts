import { createElement, type ReactElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { parseDocument } from 'htmlparser2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  address,
  contactMessage,
  customerProfile,
  newsletterSubscriber,
  order,
  user,
} from '@/db/schema';
import {
  collectCodAdmin,
  refundOrderAdmin,
  shipOrderAdmin,
  cancelOrderAdmin,
} from '@/lib/admin/orders';
import { saveContentPageAdmin } from '@/lib/admin/content';
import { createCollectionAdmin, createProductAdmin } from '@/modules/catalog';
import { adjustStockAdmin } from '@/modules/inventory';
import { handleProviderWebhook, placeOrder, type CheckoutDeps } from '@/modules/checkout';
import { ensureCustomerProfile } from '@/modules/customers';
import { assertCan, bootstrapOwner, type AdminActor, type Role } from '@/modules/staff';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  anon,
  checkoutInput,
  createFakeRazorpay,
  fillCart,
  makeDeps,
  seedShop,
  webhook,
  type FakeRazorpay,
  type Shop,
} from '../../support/shop';
import { actorOf } from '../../support/admin';

/**
 * Render every admin page against a real database as the server would, for each role, and check the HTML
 * for the things axe would flag first (labels, headings, table captions, image alt text, unique ids).
 * Next itself is not started: the session/permission check is replaced by a fixed staff context that still
 * runs the REAL assertCan, so a role without the permission gets the page's 403 state.
 */
vi.mock('server-only', () => ({}));

let current: AdminActor;
vi.mock('@/lib/staff-context', async () => {
  const { assertCan } = await import('@/modules/staff');
  const authorize = async (permission: Parameters<typeof assertCan>[1]) => {
    assertCan(current, permission);
    return { staff: current, actor: current, admin: current };
  };
  return { requireStaffFor: authorize, resolveStaffFor: authorize, tryStaffFor: authorize };
});

// Client components that call useRouter()/usePathname() need an app router, which only exists inside Next.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
  usePathname: () => '/admin',
}));
vi.mock('@/lib/session', () => ({
  getSessionUser: async () => ({ id: current.userId }),
  getCurrentStaff: async () => current,
}));

let t: TestDb;
let shop: Shop;
let fake: FakeRazorpay;
let deps: CheckoutDeps;
let ownerId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await newTestDb(40);
  process.env.DATABASE_URL = t.url;
  shop = await seedShop(t.db);
  fake = createFakeRazorpay();
  deps = makeDeps(t.db, { provider: fake.provider });
  ownerId = (
    await bootstrapOwner(t.db, {
      email: 'boss@example.test',
      name: 'Boss',
      password: 'a-long-enough-password',
    })
  ).userId;
  const owner = actorOf('owner', { userId: ownerId, email: 'boss@example.test' });

  const cod = async (variantId: string, qty = 1) => {
    const o = anon();
    await fillCart(t.db, o, [[variantId, qty]]);
    return (await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'cod' }))).order;
  };
  const online = async (variantId: string, pay = true) => {
    const o = anon();
    await fillCart(t.db, o, [[variantId, 1]]);
    const res = await placeOrder(deps, o, null, await checkoutInput(deps, o, { method: 'online' }));
    if (pay) {
      const p = fake.pay(res.providerOrderId!);
      const w = webhook('payment.captured', {
        id: p.id,
        order_id: res.providerOrderId!,
        amount: p.amount,
      });
      await handleProviderWebhook(deps, fake.provider, w.rawBody, w.headers);
    }
    return res.order;
  };

  ids.codOrder = (await cod(shop.shirt.variantIds[0]!)).id; // unfulfilled COD
  const shipped = await cod(shop.shirt.variantIds[1]!);
  await shipOrderAdmin(deps, owner, shipped.id, {
    carrier: 'DTDC',
    trackingNo: 'DT1234567',
    trackingUrl: 'https://track.test/1',
  });
  ids.shippedOrder = shipped.id;
  const paid = await online(shop.tee.variantIds[0]!);
  await refundOrderAdmin(deps, owner, paid.id, { amountPaise: 5_000, reason: 'render test' });
  ids.paidOrder = paid.id;
  const cancelled = await online(shop.shirt.variantIds[2]!);
  await cancelOrderAdmin(deps, owner, cancelled.id, { reason: 'render test cancel' });
  ids.cancelledOrder = cancelled.id;
  ids.pendingOrder = (await online(shop.tee.variantIds[0]!, false)).id;
  const collected = await cod(shop.tee.variantIds[0]!);
  await collectCodAdmin(deps, owner, collected.id);
  await t.db.update(order).set({ placedAt: new Date() }).where(eq(order.id, collected.id));

  ids.productId = shop.shirt.productId;
  ids.variantId = shop.shirt.variantIds[0]!;
  await createProductAdmin(t.db, owner, {
    name: 'Draft Tee',
    slug: 'draft-tee',
    variants: [{ sku: 'DT-1', pricePaise: 1000, stock: 1 }],
  });
  await createCollectionAdmin(t.db, owner, { name: 'Summer', slug: 'summer' });
  await adjustStockAdmin(t.db, owner, {
    variantId: ids.variantId,
    delta: 3,
    note: 'render fixture',
  });

  await t.db.insert(user).values({
    id: 'cust-1',
    name: 'Alice Kumar',
    email: 'alice@example.test',
    emailVerified: true,
  });
  await ensureCustomerProfile(t.db, 'cust-1');
  await t.db
    .update(customerProfile)
    .set({ phone: '9811111111' })
    .where(eq(customerProfile.userId, 'cust-1'));
  await t.db.insert(address).values({
    customerId: 'cust-1',
    fullName: 'Alice Kumar',
    line1: '1 Test Street',
    city: 'Panipat',
    stateCode: '06',
    pincode: '132103',
    phone: '9811111111',
    isDefault: true,
  });
  ids.customerId = 'cust-1';
  await t.db
    .insert(contactMessage)
    .values({ name: 'Asha', email: 'asha@example.test', message: 'Where is my order?' });
  await t.db
    .insert(newsletterSubscriber)
    .values({ firstName: 'Meera', email: 'meera@example.test' });
  await saveContentPageAdmin(t.db, owner, 'faq', {
    title: 'FAQ',
    body: '## Hi\n\nText\n\n- a\n- b',
    published: true,
  });
});

afterAll(async () => {
  const { closeDb } = await import('@/db/client');
  await closeDb();
  await t.close();
});

// ---- helpers -----------------------------------------------------------------------------------

type N = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: N[];
  parent?: N | null;
};
const insideLabel = (n: N): boolean => {
  for (let p = n.parent; p; p = p.parent) if (p.type === 'tag' && p.name === 'label') return true;
  return false;
};
const walk = (n: N, fn: (n: N) => void) => {
  fn(n);
  n.children?.forEach((c) => walk(c, fn));
};
const tags = (root: N, ...names: string[]) => {
  const out: N[] = [];
  walk(root, (n) => n.type === 'tag' && names.includes(n.name!) && out.push(n));
  return out;
};
const textOf = (n: N): string =>
  n.type === 'text' ? (n.data ?? '') : (n.children ?? []).map(textOf).join('');

async function render(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const stream = await renderToReadableStream(await el);
  await stream.allReady;
  return new Response(stream).text();
}

type PageModule = { default: (props: never) => unknown };
async function page(
  path: string,
  props: { params?: Record<string, string>; searchParams?: Record<string, string> } = {},
): Promise<string> {
  const mod = (await import(/* @vite-ignore */ `@/app/admin/(panel)/${path}`)) as PageModule;
  const el = await (mod.default as unknown as (p: unknown) => Promise<ReactElement>)({
    params: Promise.resolve(props.params ?? {}),
    searchParams: Promise.resolve(props.searchParams ?? {}),
  });
  return render(el);
}

/** The accessibility basics axe checks first. Returns a list of problems (empty means clean). */
function a11yProblems(html: string): string[] {
  const doc = parseDocument(html) as unknown as N;
  const problems: string[] = [];
  const idsSeen = new Map<string, number>();
  walk(
    doc,
    (n) =>
      n.type === 'tag' &&
      n.attribs?.id &&
      idsSeen.set(n.attribs.id, (idsSeen.get(n.attribs.id) ?? 0) + 1),
  );
  for (const [id, n] of idsSeen) if (n > 1) problems.push(`duplicate id ${id}`);

  const h1 = tags(doc, 'h1');
  if (h1.length !== 1) problems.push(`expected one h1, found ${h1.length}`);
  const labelFor = new Set(
    tags(doc, 'label')
      .map((l) => l.attribs?.for)
      .filter(Boolean),
  );
  for (const c of tags(doc, 'input', 'textarea', 'select')) {
    if (c.name === 'input' && ['hidden', 'submit'].includes(c.attribs?.type ?? '')) continue;
    const named =
      c.attribs?.['aria-label'] ||
      c.attribs?.['aria-labelledby'] ||
      (c.attribs?.id && labelFor.has(c.attribs.id)) ||
      insideLabel(c);
    if (!named) problems.push(`unlabelled ${c.name} name=${c.attribs?.name}`);
  }
  for (const img of tags(doc, 'img'))
    if (img.attribs?.alt === undefined) problems.push(`img without alt: ${img.attribs?.src}`);
  for (const table of tags(doc, 'table')) {
    const hasCaption = tags(table, 'caption').length > 0 || table.attribs?.['aria-label'];
    if (!hasCaption) problems.push('table without caption');
    if (tags(table, 'th').some((th) => !th.attribs?.scope)) problems.push('th without scope');
  }
  for (const a of tags(doc, 'a')) {
    if (!textOf(a).trim() && !a.attribs?.['aria-label'])
      problems.push(`empty link ${a.attribs?.href}`);
    if (a.attribs?.target === '_blank' && !/noopener/.test(a.attribs?.rel ?? ''))
      problems.push('target=_blank without noopener');
  }
  for (const b of tags(doc, 'button')) {
    if (!textOf(b).trim() && !b.attribs?.['aria-label']) problems.push('button without a name');
  }
  for (const n of tags(
    doc,
    ...['input', 'textarea', 'select', 'div', 'p', 'section', 'table', 'form', 'details'],
  )) {
    for (const key of ['aria-describedby', 'aria-labelledby'] as const) {
      for (const ref of (n.attribs?.[key] ?? '').split(/\s+/).filter(Boolean)) {
        if (!idsSeen.has(ref)) problems.push(`${key} points at missing id ${ref}`);
      }
    }
  }
  for (const d of tags(doc, 'details'))
    if (tags(d, 'summary').length === 0) problems.push('details without summary');
  return problems;
}

const as = (role: Role, over: Partial<AdminActor> = {}) =>
  (current = actorOf(role, { userId: role === 'owner' ? ownerId : `${role}-1`, ...over }));

// ---- the pages ---------------------------------------------------------------------------------

type Case = { name: string; path: string; props?: Parameters<typeof page>[1]; expect: string[] };
const cases = (): Case[] => [
  {
    name: 'dashboard',
    path: 'page',
    expect: [
      'Dashboard',
      'Orders today',
      'Awaiting shipment',
      'Awaiting COD collection',
      'Low-stock variants',
      'Sales this month',
      'Recent orders',
    ],
  },
  {
    name: 'orders list',
    path: 'orders/page',
    expect: ['Orders', 'Asha Verma', 'Awaiting payment'],
  },
  {
    name: 'orders list filtered',
    path: 'orders/page',
    props: {
      searchParams: {
        q: 'asha',
        status: 'confirmed',
        payment: 'cod',
        sort: 'total_desc',
        pageSize: '5',
        page: '1',
      },
    },
    expect: ['Orders'],
  },
  {
    name: 'orders list empty result',
    path: 'orders/page',
    props: { searchParams: { q: 'zzz-nothing' } },
    expect: ['No orders match these filters'],
  },
  {
    name: 'order (COD, unfulfilled)',
    path: 'orders/[id]/page',
    props: { params: { id: ids.codOrder! } },
    expect: ['Mark as shipped', 'Cancel order', 'Internal note'],
  },
  {
    name: 'order (shipped)',
    path: 'orders/[id]/page',
    props: { params: { id: ids.shippedOrder! } },
    expect: ['Mark delivered', 'Track (opens in a new tab)', 'DT1234567', 'CGST'],
  },
  {
    name: 'order (paid, partly refunded)',
    path: 'orders/[id]/page',
    props: { params: { id: ids.paidOrder! }, searchParams: { notice: 'order-refunded' } },
    expect: ['Refund recorded.', 'Refunds', 'Payment attempts', 'render test'],
  },
  {
    name: 'order (cancelled)',
    path: 'orders/[id]/page',
    props: { params: { id: ids.cancelledOrder! } },
    expect: ['Cancelled', 'render test cancel'],
  },
  {
    name: 'order (awaiting payment)',
    path: 'orders/[id]/page',
    props: { params: { id: ids.pendingOrder! } },
    expect: ['Awaiting payment'],
  },
  {
    name: 'products list',
    path: 'products/page',
    expect: ['Oxford Shirt', 'New product', 'Draft Tee'],
  },
  {
    name: 'products list filtered',
    path: 'products/page',
    props: { searchParams: { q: 'draft', status: 'draft' } },
    expect: ['Draft Tee'],
  },
  {
    name: 'new product',
    path: 'products/new/page',
    expect: ['First variant', 'Create draft product'],
  },
  {
    name: 'edit product',
    path: 'products/[id]/page',
    props: { params: { id: ids.productId! } },
    expect: [
      'Variants and stock',
      'Upload an image',
      'Collections',
      'Delete product',
      'oxford-shirt-S',
    ],
  },
  {
    name: 'categories and collections',
    path: 'products/categories/page',
    expect: ['Tops', 'Summer'],
  },
  { name: 'inventory', path: 'inventory/page', expect: ['oxford-shirt-S', 'On hand'] },
  {
    name: 'inventory (low only)',
    path: 'inventory/page',
    props: { searchParams: { low: '1' } },
    expect: ['Inventory'],
  },
  {
    name: 'variant stock history',
    path: 'inventory/[variantId]/page',
    props: { params: { variantId: ids.variantId! } },
    expect: ['Movement history', 'render fixture'],
  },
  {
    name: 'settings',
    path: 'settings/page',
    expect: ['Payment provider', 'GST rules', 'Apparel GST'],
  },
  { name: 'staff', path: 'staff/page', expect: ['boss@example.test', 'Create a staff account'] },
  { name: 'content list', path: 'content/page', expect: ['FAQ', 'Starter text'] },
  {
    name: 'content editor',
    path: 'content/[slug]/page',
    props: { params: { slug: 'faq' } },
    expect: ['Live preview', 'Save page'],
  },
  { name: 'messages', path: 'messages/page', expect: ['Where is my order?', 'Mark handled'] },
  {
    name: 'subscribers',
    path: 'messages/page',
    props: { searchParams: { tab: 'subscribers' } },
    expect: ['meera@example.test'],
  },
  { name: 'customers', path: 'customers/page', expect: ['Alice Kumar'] },
  {
    name: 'customer detail',
    path: 'customers/[id]/page',
    props: { params: { id: 'cust-1' } },
    expect: ['Saved addresses', 'Panipat'],
  },
  {
    name: 'audit log',
    path: 'audit/page',
    expect: ['Audit log', 'order.ship', 'Before and after'],
  },
  {
    name: 'audit log filtered',
    path: 'audit/page',
    props: { searchParams: { entity: 'order', action: 'order.ship', from: '2020-01-01' } },
    expect: ['order.ship'],
  },
  {
    name: 'reports',
    path: 'reports/page',
    expect: ['Gross sales', 'Net sales', 'Average order value', 'Online versus cash on delivery'],
  },
  {
    name: 'reports (bad range)',
    path: 'reports/page',
    props: { searchParams: { from: '2026-05-10', to: '2026-05-01' } },
    expect: ['must not be before'],
  },
];

describe('owner: every admin page renders with its data and passes the HTML accessibility basics', () => {
  it('renders all pages', async () => {
    as('owner');
    for (const c of cases()) {
      const html = await page(c.path, c.props);
      for (const text of c.expect)
        expect(html, `${c.name} should contain "${text}"`).toContain(text);
      expect(html, `${c.name} must not show the 403 state`).not.toContain('403 · Not allowed');
      expect(a11yProblems(html), c.name).toEqual([]);
    }
  });
});

describe('role gating: a page the role cannot use shows a clear 403 state, never a blank page', () => {
  const needs: Record<string, Role[]> = {
    // pages by the roles that may use them
    'orders/page': ['owner', 'manager', 'support'],
    'products/page': ['owner', 'manager'],
    'inventory/page': ['owner', 'manager'],
    'customers/page': ['owner', 'manager', 'support'],
    'messages/page': ['owner', 'manager', 'support'],
    'reports/page': ['owner', 'manager'],
    'content/page': ['owner', 'manager'],
    'audit/page': ['owner', 'manager'],
    'staff/page': ['owner'],
    'settings/page': ['owner'],
    'products/new/page': ['owner', 'manager'],
    'products/categories/page': ['owner', 'manager'],
  };
  for (const [path, allowed] of Object.entries(needs)) {
    for (const role of ['owner', 'manager', 'support'] as Role[]) {
      it(`${path} as ${role}: ${allowed.includes(role) ? 'allowed' : '403'}`, async () => {
        as(role);
        const html = await page(path);
        if (allowed.includes(role)) {
          expect(html).not.toContain('403 · Not allowed');
          expect(a11yProblems(html)).toEqual([]);
        } else {
          expect(html).toContain('403 · Not allowed');
          expect(html).toContain('role="alert"');
          expect(a11yProblems(html)).toEqual([]);
        }
      });
    }
  }

  it('owners and managers without 2FA get the two-factor 403 state', async () => {
    as('manager', { twoFactorEnabled: false });
    const html = await page('orders/page');
    expect(html).toContain('Two-factor authentication is required');
  });

  it('support sees the order but no shipping, cancel or refund controls; manager sees them', async () => {
    as('support');
    const s = await page('orders/[id]/page', { params: { id: ids.codOrder! } });
    expect(s).toContain('Add note');
    expect(s).not.toContain('Mark as shipped');
    expect(s).not.toContain('Cancel this order');
    expect(s).toContain('Your role can view orders and add notes');
    as('manager');
    const m = await page('orders/[id]/page', { params: { id: ids.codOrder! } });
    expect(m).toContain('Mark as shipped');
    expect(m).toContain('Cancel order');
    const paid = await page('orders/[id]/page', { params: { id: ids.paidOrder! } });
    expect(paid).toContain('Refund');
    as('support');
    expect(await page('orders/[id]/page', { params: { id: ids.paidOrder! } })).not.toContain(
      'Issue refund',
    );
  });

  it('unknown ids give the not-found state, not a crash', async () => {
    as('owner');
    for (const [path, params] of [
      ['orders/[id]/page', { id: '33333333-3333-4333-8333-333333333333' }],
      ['products/[id]/page', { id: '33333333-3333-4333-8333-333333333333' }],
      ['customers/[id]/page', { id: 'nobody' }],
      ['content/[slug]/page', { slug: 'invented' }],
      ['inventory/[variantId]/page', { variantId: 'nope' }],
    ] as const) {
      await expect(page(path, { params })).rejects.toMatchObject({
        digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404'),
      });
    }
  });
});

describe('the panel layout shows only the entries a role may use', () => {
  const EVERYTHING = [
    'Dashboard',
    'Orders',
    'Products',
    'Inventory',
    'Customers',
    'Messages',
    'Reports',
    'Content',
    'Audit log',
    'Staff',
    'Settings',
  ];
  // Other screens may be added to the nav later, so assert what each role must and must not see.
  const MUST: Record<Role, string[]> = {
    owner: EVERYTHING,
    manager: EVERYTHING.filter((l) => !['Staff', 'Settings'].includes(l)),
    support: ['Dashboard', 'Orders', 'Customers', 'Messages'],
  };
  const MUST_NOT: Record<Role, string[]> = {
    owner: [],
    manager: ['Staff', 'Settings'],
    support: ['Products', 'Inventory', 'Reports', 'Content', 'Audit log', 'Staff', 'Settings'],
  };

  it.each(['owner', 'manager', 'support'] as const)('%s', async (role) => {
    as(role);
    const { default: Layout } = await import('@/app/admin/(panel)/layout');
    const html = await render(await Layout({ children: createElement('p', null, 'child') }));
    const doc = parseDocument(html) as unknown as N;
    const nav = tags(doc, 'nav').find((n) => n.attribs?.['aria-label'] === 'Admin sections')!;
    const labels = tags(nav, 'a').map((a) => textOf(a).trim());
    expect(labels).toEqual(expect.arrayContaining(MUST[role]));
    for (const hidden of MUST_NOT[role]) expect(labels).not.toContain(hidden);
    expect(html).toContain('Skip to content');
    expect(tags(doc, 'main')).toHaveLength(1);
  });

  it('is gated by the real permission matrix', () => {
    expect(() => assertCan(actorOf('support'), 'reports.view')).toThrow();
  });
});

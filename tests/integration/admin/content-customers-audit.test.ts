import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  address,
  auditEvent,
  contactMessage,
  contentPage,
  customerProfile,
  newsletterSubscriber,
  user,
} from '@/db/schema';
import { searchAuditAdmin, auditFilterOptionsAdmin } from '@/lib/admin/audit';
import {
  getContentPageAdmin,
  listContentPagesAdmin,
  saveContentPageAdmin,
} from '@/lib/admin/content';
import {
  listContactMessagesAdmin,
  listNewsletterSubscribersAdmin,
  setContactMessageHandled,
} from '@/lib/admin/messages';
import { getContentPage } from '@/lib/content';
import { recordAudit } from '@/modules/audit';
import { ensureCustomerProfile, getCustomerAdmin, listCustomersAdmin } from '@/modules/customers';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  actorOf,
  auditCount,
  breakAuditFor,
  manager,
  manager2faOff,
  owner,
  owner2faOff,
  support,
} from '../../support/admin';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('content pages', () => {
  it('lists starter pages that were never saved, then saves one (upsert) with an audit trail', async () => {
    const list = await listContentPagesAdmin(t.db, manager());
    const faq = list.find((p) => p.slug === 'faq')!;
    expect(faq.isDefaultText).toBe(true);
    expect(await getContentPage(t.db, 'faq')).toBeNull(); // not live until saved

    const actor = manager();
    await saveContentPageAdmin(t.db, actor, 'faq', {
      title: 'Frequently asked questions',
      body: '## Shipping\n\nWe ship in 3 days.\n\n- Item one\n- Item two',
      published: true,
    });
    const live = await getContentPage(t.db, 'faq');
    expect(live).toMatchObject({ title: 'Frequently asked questions', published: true });
    const [a] = await t.db.select().from(auditEvent).where(eq(auditEvent.entityId, 'faq'));
    expect(a).toMatchObject({
      action: 'content.update',
      actorUserId: actor.userId,
      ip: '203.0.113.9',
      before: null,
    });

    await saveContentPageAdmin(t.db, actor, 'faq', {
      title: 'FAQ',
      body: 'Short.',
      published: false,
    });
    expect(await getContentPage(t.db, 'faq')).toBeNull(); // unpublished
    const audits = await t.db.select().from(auditEvent).where(eq(auditEvent.entityId, 'faq'));
    const second = audits.find(
      (x) => (x.before as { title?: string } | null)?.title === 'Frequently asked questions',
    );
    expect(second?.after).toMatchObject({ title: 'FAQ', published: false });
    expect((await getContentPageAdmin(t.db, actor, 'faq'))?.isDefaultText).toBe(false);
  });

  it('validates, refuses unknown slugs, and keeps markup as inert text', async () => {
    await expect(
      saveContentPageAdmin(t.db, owner(), 'about', { title: '', body: 'x', published: true }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fieldErrors: { title: expect.any(String) } },
    });
    await expect(
      saveContentPageAdmin(t.db, owner(), 'about', {
        title: 'T',
        body: 'x'.repeat(50_001),
        published: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      saveContentPageAdmin(t.db, owner(), 'invented-page', {
        title: 'T',
        body: 'x',
        published: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await getContentPageAdmin(t.db, owner(), 'invented-page')).toBeNull();
    await saveContentPageAdmin(t.db, owner(), 'about', {
      title: 'About',
      body: '<script>alert(1)</script>',
      published: true,
    });
    const { parseContent } = await import('@/lib/content-format');
    expect(parseContent((await getContentPage(t.db, 'about'))!.body)).toEqual([
      { type: 'p', text: '<script>alert(1)</script>' }, // plain text paragraph, rendered escaped by React
    ]);
  });

  it('catalog.edit is required: support denied, no-2FA manager/owner refused; nothing written', async () => {
    const n = await auditCount(t.db);
    const input = { title: 'Hacked', body: 'x', published: true };
    await expect(saveContentPageAdmin(t.db, support(), 'terms', input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(saveContentPageAdmin(t.db, manager2faOff(), 'terms', input)).rejects.toMatchObject(
      {
        code: 'TWO_FACTOR_REQUIRED',
      },
    );
    await expect(saveContentPageAdmin(t.db, owner2faOff(), 'terms', input)).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    await expect(listContentPagesAdmin(t.db, support())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await auditCount(t.db)).toBe(n);
    expect(await t.db.select().from(contentPage).where(eq(contentPage.slug, 'terms'))).toHaveLength(
      0,
    );
  });

  it('rolls the page back when the audit write fails', async () => {
    const restore = await breakAuditFor(t, 'content.update');
    try {
      await expect(
        saveContentPageAdmin(t.db, owner(), 'privacy', {
          title: 'Privacy',
          body: 'x',
          published: true,
        }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(
      await t.db.select().from(contentPage).where(eq(contentPage.slug, 'privacy')),
    ).toHaveLength(0);
  });
});

describe('contact messages and newsletter subscribers', () => {
  let ids: string[];
  beforeAll(async () => {
    const rows = await t.db
      .insert(contactMessage)
      .values([
        { name: 'Asha', email: 'asha@example.test', message: 'Where is my order number 1001?' },
        { name: 'Ravi', email: 'ravi@example.test', message: 'Do you restock the Oxford shirt?' },
      ])
      .returning({ id: contactMessage.id });
    ids = rows.map((r) => r.id);
    await t.db.insert(newsletterSubscriber).values([
      { firstName: 'Meera', email: 'meera@example.test', phone: '9000000011' },
      { firstName: 'Kabir', email: 'kabir@example.test' },
    ]);
  });

  it('marks a message handled and reopens it; audited; open list shrinks', async () => {
    const actor = support(); // customers.view is held by support
    expect((await listContactMessagesAdmin(t.db, actor)).total).toBe(2);
    await setContactMessageHandled(t.db, actor, ids[0]!, true);
    expect((await listContactMessagesAdmin(t.db, actor, { status: 'open' })).total).toBe(1);
    expect((await listContactMessagesAdmin(t.db, actor, { status: 'handled' })).items[0]?.id).toBe(
      ids[0],
    );
    expect((await listContactMessagesAdmin(t.db, actor, { status: 'all' })).total).toBe(2);
    const [a] = await t.db.select().from(auditEvent).where(eq(auditEvent.entityId, ids[0]!));
    expect(a).toMatchObject({
      action: 'contact_message.handle',
      actorUserId: actor.userId,
      actorRole: 'support',
      ip: '203.0.113.9',
      before: { handled: false },
      after: { handled: true },
    });
    await expect(setContactMessageHandled(t.db, actor, ids[0]!, true)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await setContactMessageHandled(t.db, actor, ids[0]!, false);
    const [row] = await t.db.select().from(contactMessage).where(eq(contactMessage.id, ids[0]!));
    expect(row?.handledAt).toBeNull();
  });

  it('unknown id is NOT_FOUND, a malformed id is rejected, no-2FA owner refused, rollback on audit failure', async () => {
    await expect(
      setContactMessageHandled(t.db, owner(), '44444444-4444-4444-8444-444444444444', true),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setContactMessageHandled(t.db, owner(), 'nope', true)).rejects.toThrow();
    await expect(
      setContactMessageHandled(t.db, owner2faOff(), ids[1]!, true),
    ).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    const restore = await breakAuditFor(t, 'contact_message.handle');
    try {
      await expect(setContactMessageHandled(t.db, owner(), ids[1]!, true)).rejects.toThrow();
    } finally {
      await restore();
    }
    const [row] = await t.db.select().from(contactMessage).where(eq(contactMessage.id, ids[1]!));
    expect(row?.handledAt).toBeNull();
  });

  it('lists and searches subscribers read-only', async () => {
    const all = await listNewsletterSubscribersAdmin(t.db, support());
    expect(all.total).toBe(2);
    expect(
      (await listNewsletterSubscribersAdmin(t.db, support(), { q: 'meera' })).items,
    ).toHaveLength(1);
    expect(
      (await listNewsletterSubscribersAdmin(t.db, support(), { q: '900000' })).items,
    ).toHaveLength(1);
    expect((await listNewsletterSubscribersAdmin(t.db, support(), { q: '%' })).total).toBe(0);
    expect(
      (await listNewsletterSubscribersAdmin(t.db, support(), { pageSize: 5000 })).pageSize,
    ).toBe(100);
  });
});

describe('customers', () => {
  beforeAll(async () => {
    await t.db.insert(user).values([
      { id: 'cust-1', name: 'Alice Kumar', email: 'alice@example.test', emailVerified: true },
      { id: 'cust-2', name: 'Bob Singh', email: 'bob@example.test' },
      { id: 'staff-1', name: 'A Staffer', email: 'staff@example.test' }, // no customer profile: not a customer
    ]);
    await ensureCustomerProfile(t.db, 'cust-1');
    await ensureCustomerProfile(t.db, 'cust-2');
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
  });

  it('lists customers only (not staff) and searches name, email and phone, all roles with customers.view', async () => {
    const all = await listCustomersAdmin(t.db, support());
    expect(all.items.map((c) => c.email).sort()).toEqual([
      'alice@example.test',
      'bob@example.test',
    ]);
    expect((await listCustomersAdmin(t.db, manager(), { q: 'alice' })).items).toHaveLength(1);
    expect((await listCustomersAdmin(t.db, owner(), { q: '9811' })).items[0]?.email).toBe(
      'alice@example.test',
    );
    expect((await listCustomersAdmin(t.db, owner(), { q: 'staff@' })).total).toBe(0);
    expect((await listCustomersAdmin(t.db, owner(), { q: '%' })).total).toBe(0);
    expect((await listCustomersAdmin(t.db, owner(), { pageSize: 1000 })).pageSize).toBe(100);
  });

  it('shows one customer with addresses; a staff id or unknown id is null', async () => {
    const c = await getCustomerAdmin(t.db, support(), 'cust-1');
    expect(c).toMatchObject({ name: 'Alice Kumar', phone: '9811111111', emailVerified: true });
    expect(c?.addresses).toHaveLength(1);
    expect(await getCustomerAdmin(t.db, support(), 'staff-1')).toBeNull();
    expect(await getCustomerAdmin(t.db, support(), 'nobody')).toBeNull();
  });

  it('refuses owners/managers without 2FA', async () => {
    await expect(listCustomersAdmin(t.db, manager2faOff())).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    await expect(getCustomerAdmin(t.db, owner2faOff(), 'cust-1')).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });
});

describe('audit log search', () => {
  beforeAll(async () => {
    const o = actorOf('owner', { userId: 'owner-a' });
    const m = actorOf('manager', { userId: 'manager-b' });
    for (let i = 0; i < 7; i++) {
      await recordAudit(t.db, {
        actor: i % 2 ? o : m,
        action: 'product.update',
        entity: 'product',
        entityId: `p-${i}`,
        before: { a: i },
        after: { a: i + 1 },
      });
    }
    await recordAudit(t.db, {
      actor: o,
      action: 'order.refund',
      entity: 'order',
      entityId: 'o-1',
      after: { amountPaise: 100 },
    });
    await recordAudit(t.db, { actor: o, action: 'order.cancel', entity: 'order', entityId: 'o-2' });
  });

  it('filters by entity, entityId, actor, action prefix and date, with stable pagination', async () => {
    const m = actorOf('manager');
    const byEntity = await searchAuditAdmin(t.db, m, { entity: 'order' });
    expect(byEntity.items.every((r) => r.entity === 'order')).toBe(true);
    expect(byEntity.total).toBe(2);
    expect((await searchAuditAdmin(t.db, m, { entityId: 'p-3' })).items).toHaveLength(1);
    const byActor = await searchAuditAdmin(t.db, m, { actorUserId: 'manager-b' });
    expect(byActor.items.every((r) => r.actorUserId === 'manager-b')).toBe(true);
    const prefix = await searchAuditAdmin(t.db, m, { action: 'order.' });
    expect(prefix.items.map((r) => r.action).sort()).toEqual(['order.cancel', 'order.refund']);
    expect((await searchAuditAdmin(t.db, m, { action: 'order_' })).total).toBe(0); // underscore is literal
    const future = await searchAuditAdmin(t.db, m, { from: new Date(Date.now() + 86_400_000) });
    expect(future.total).toBe(0);
    const past = await searchAuditAdmin(t.db, m, { to: new Date('2000-01-01T00:00:00Z') });
    expect(past.total).toBe(0);
    const window = await searchAuditAdmin(t.db, m, {
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
      entity: 'product',
    });
    expect(window.total).toBe(7);

    const p1 = await searchAuditAdmin(t.db, m, { entity: 'product', pageSize: 3, page: 1 });
    const p2 = await searchAuditAdmin(t.db, m, { entity: 'product', pageSize: 3, page: 2 });
    const p3 = await searchAuditAdmin(t.db, m, { entity: 'product', pageSize: 3, page: 3 });
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([3, 3, 1]);
    expect(p1.pageCount).toBe(3);
    const seen = new Set([...p1.items, ...p2.items, ...p3.items].map((r) => r.id));
    expect(seen.size).toBe(7);
    expect((await searchAuditAdmin(t.db, m, { pageSize: 5000 })).pageSize).toBe(100);
  });

  it('exposes before and after JSON and filter options', async () => {
    const m = actorOf('manager');
    const [row] = (await searchAuditAdmin(t.db, m, { entityId: 'p-2' })).items;
    expect(row).toMatchObject({ before: { a: 2 }, after: { a: 3 } });
    const opts = await auditFilterOptionsAdmin(t.db, m);
    expect(opts.entities).toEqual(expect.arrayContaining(['order', 'product']));
    expect(opts.actions).toEqual(expect.arrayContaining(['order.refund', 'product.update']));
  });

  it('is limited to audit.view: support denied, no-2FA manager refused', async () => {
    await expect(searchAuditAdmin(t.db, support(), {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(searchAuditAdmin(t.db, manager2faOff(), {})).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    await expect(auditFilterOptionsAdmin(t.db, support())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

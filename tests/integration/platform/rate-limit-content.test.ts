import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactMessage, contentPage, outboxEvent } from '@/db/platform-schema';
import {
  contactInput,
  ensureDefaultContentPages,
  getContentPage,
  saveContactMessage,
  upsertContentPage,
} from '@/lib/content';
import { DEFAULT_CONTENT_PAGES } from '@/lib/content-defaults';
import { hitRateLimit } from '@/lib/rate-limit';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('Postgres rate limiter (no Redis in R1)', () => {
  it('allows up to the limit then blocks, and reports a retry time', async () => {
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await hitRateLimit(t.db, 'unit:a', 5, 60));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(results[5]?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(results[5]?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keys are independent', async () => {
    for (let i = 0; i < 3; i++) await hitRateLimit(t.db, 'unit:x', 3, 60);
    expect((await hitRateLimit(t.db, 'unit:x', 3, 60)).allowed).toBe(false);
    expect((await hitRateLimit(t.db, 'unit:y', 3, 60)).allowed).toBe(true);
  });

  it('counts exactly under 40 concurrent requests: precisely `limit` are allowed', async () => {
    const res = await Promise.all(
      Array.from({ length: 40 }, () => hitRateLimit(t.db, 'unit:burst', 10, 60)),
    );
    expect(res.filter((r) => r.allowed)).toHaveLength(10);
    expect(Math.max(...res.map((r) => r.count))).toBe(40);
  });
});

describe('content pages', () => {
  it('serves published pages only', async () => {
    await upsertContentPage(t.db, { slug: 'live', title: 'Live', body: 'hello' });
    await upsertContentPage(t.db, { slug: 'hidden', title: 'Hidden', body: 'x', published: false });
    expect((await getContentPage(t.db, 'live'))?.title).toBe('Live');
    expect(await getContentPage(t.db, 'hidden')).toBeNull();
    expect(await getContentPage(t.db, 'missing')).toBeNull();
  });

  it('seeding defaults never overwrites text the owner edited', async () => {
    const created = await ensureDefaultContentPages(t.db);
    expect(created).toBe(DEFAULT_CONTENT_PAGES.length);
    await upsertContentPage(t.db, { slug: 'faq', title: 'FAQs', body: 'Owner wrote this.' });
    expect(await ensureDefaultContentPages(t.db)).toBe(0);
    expect((await getContentPage(t.db, 'faq'))?.body).toBe('Owner wrote this.');
  });

  it('every footer link target has a page', async () => {
    const slugs = (await t.db.select({ s: contentPage.slug }).from(contentPage)).map((r) => r.s);
    for (const s of [
      'faq',
      'product-care',
      'size-charts',
      'shipping',
      'exchanges-returns',
      'gift-cards',
      'about',
      'contact',
      'visit-us',
      'environmental-promises',
      'terms',
      'privacy',
    ]) {
      expect(slugs, s).toContain(s);
    }
  });
});

describe('contact form storage', () => {
  const msg = {
    name: 'Asha',
    email: 'asha@example.test',
    message: 'Is the oxford shirt true to size?',
  };

  it('validates input', () => {
    expect(() => contactInput.parse({ ...msg, email: 'nope' })).toThrow();
    expect(() => contactInput.parse({ ...msg, message: 'short' })).toThrow();
    expect(() => contactInput.parse({ ...msg, message: 'x'.repeat(2001) })).toThrow();
    expect(contactInput.parse({ ...msg, email: '  ASHA@Example.TEST ' }).email).toBe(
      'asha@example.test',
    );
  });

  it('stores the message and queues an email through the outbox when an inbox is set', async () => {
    const id = await t.db.transaction((tx) =>
      saveContactMessage(tx, contactInput.parse(msg), '203.0.113.5', 'owner@shop.test'),
    );
    const [row] = await t.db.select().from(contactMessage).where(eq(contactMessage.id, id));
    expect(row).toMatchObject({ name: 'Asha', ip: '203.0.113.5' });
    const events = await t.db.select().from(outboxEvent).where(eq(outboxEvent.type, 'email.send'));
    const mail = events
      .map((e) => e.payload as { to: string; text: string })
      .find((p) => p.to === 'owner@shop.test');
    expect(mail?.text).toContain('true to size');
  });

  it('without an inbox the message is stored and no email is queued', async () => {
    const before = (await t.db.select().from(outboxEvent)).length;
    await t.db.transaction((tx) =>
      saveContactMessage(tx, contactInput.parse(msg), null, undefined),
    );
    expect((await t.db.select().from(outboxEvent)).length).toBe(before);
  });

  it('rolls the message back if the surrounding transaction fails', async () => {
    const before = (await t.db.select().from(contactMessage)).length;
    await expect(
      t.db.transaction(async (tx) => {
        await saveContactMessage(tx, contactInput.parse(msg), null, 'owner@shop.test');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await t.db.select().from(contactMessage)).length).toBe(before);
  });
});

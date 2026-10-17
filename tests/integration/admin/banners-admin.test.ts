import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent, siteBanner } from '@/db/schema';
import {
  clearFaviconAdmin,
  deleteBannerAdmin,
  listBannersAdmin,
  moveBannerAdmin,
  setFaviconAdmin,
  updateBannerAdmin,
  uploadBannerAdmin,
} from '@/lib/admin/banners';
import { DEFAULT_FAVICON, getFaviconKey, getFaviconUrl, listActiveBanners } from '@/lib/banners';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  auditCount,
  manager,
  memoryStorage,
  owner,
  owner2faOff,
  pngBytes,
  support,
} from '../../support/admin';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const upload = async (
  mem: ReturnType<typeof memoryStorage>,
  alt: string,
  linkUrl = '',
  actor = manager(),
) =>
  uploadBannerAdmin(t.db, actor, mem.storage, {
    bytes: await pngBytes(1200, 300),
    alt,
    linkUrl,
  });

describe('banners', () => {
  it('uploads a re-encoded WebP, stores a random key, audits it, and shows it on the shop in order', async () => {
    const mem = memoryStorage();
    const before = await auditCount(t.db);
    const a = await upload(mem, 'Summer drop', '/collections/new-in');
    const b = await upload(mem, 'Second banner');

    const keys = [...mem.objects.keys()];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^banners\/[0-9a-f]{32}\.webp$/);
    expect([...mem.objects.values()][0]!.contentType).toBe('image/webp');
    expect(await auditCount(t.db)).toBe(before + 2);

    const active = await listActiveBanners(t.db);
    expect(active.map((x) => x.alt)).toEqual(['Summer drop', 'Second banner']);
    expect(active[0]!.linkUrl).toBe('/collections/new-in');
    expect(active[1]!.linkUrl).toBeNull();
    expect(active[0]!.imageUrl).toMatch(/^(\/media\/|https?:\/\/).*banners\/[0-9a-f]{32}\.webp$/);

    // Hidden banners never reach the shop.
    await updateBannerAdmin(t.db, manager(), a.id, { active: false });
    expect((await listActiveBanners(t.db)).map((x) => x.alt)).toEqual(['Second banner']);
    await updateBannerAdmin(t.db, manager(), a.id, { active: true });

    // Order can be changed, and the change is audited.
    await moveBannerAdmin(t.db, manager(), b.id, 'up');
    expect((await listActiveBanners(t.db)).map((x) => x.alt)).toEqual([
      'Second banner',
      'Summer drop',
    ]);
    const moved = await t.db.select().from(auditEvent).where(eq(auditEvent.action, 'banner.move'));
    expect(moved).toHaveLength(1);

    // Delete removes the row and the stored file.
    await deleteBannerAdmin(t.db, manager(), mem.storage, a.id);
    await deleteBannerAdmin(t.db, manager(), mem.storage, b.id);
    expect(mem.objects.size).toBe(0);
    expect(await listBannersAdmin(t.db, manager())).toHaveLength(0);
  });

  it('refuses links that could run script or leave the shop unexpectedly', async () => {
    const mem = memoryStorage();
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example',
      'data:text/html,x',
      'http://plain.example',
    ]) {
      await expect(upload(mem, 'x', bad)).rejects.toThrow();
    }
    expect(mem.objects.size).toBe(0);
    expect(await t.db.select().from(siteBanner)).toHaveLength(0);
  });

  it('refuses files that are not real images, and an SVG', async () => {
    const mem = memoryStorage();
    await expect(
      uploadBannerAdmin(t.db, manager(), mem.storage, {
        bytes: new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
        ),
        alt: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      uploadBannerAdmin(t.db, manager(), mem.storage, {
        bytes: new TextEncoder().encode('not an image at all'),
        alt: 'x',
      }),
    ).rejects.toThrow();
    expect(mem.objects.size).toBe(0);
  });

  it('removes the stored file when the audit write fails (nothing is half-saved)', async () => {
    const { breakAuditFor } = await import('../../support/admin');
    const mem = memoryStorage();
    const undo = await breakAuditFor(t, 'banner.create');
    try {
      await expect(upload(mem, 'will fail')).rejects.toThrow();
    } finally {
      await undo();
    }
    expect(mem.objects.size).toBe(0);
    expect(await t.db.select().from(siteBanner)).toHaveLength(0);
  });

  it('only owner and manager (with 2FA) may manage banners; support may not', async () => {
    const mem = memoryStorage();
    await expect(upload(mem, 'x', '', support())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(upload(mem, 'x', '', owner2faOff())).rejects.toThrow();
    await expect(listBannersAdmin(t.db, support())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mem.objects.size).toBe(0);
  });
});

describe('site icon', () => {
  it('is replaced by an upload (shrunk), the old file is deleted, and it can be reset', async () => {
    const mem = memoryStorage();
    expect(await getFaviconUrl(t.db)).toBe(DEFAULT_FAVICON);

    await setFaviconAdmin(t.db, owner(), mem.storage, await pngBytes(1024, 1024));
    const first = await getFaviconKey(t.db);
    expect(first).toMatch(/^site\/[0-9a-f]{32}\.webp$/);
    expect(await getFaviconUrl(t.db)).toContain(first!);

    await setFaviconAdmin(t.db, owner(), mem.storage, await pngBytes(512, 512));
    const second = await getFaviconKey(t.db);
    expect(second).not.toBe(first);
    expect(mem.objects.has(first!)).toBe(false);
    expect(mem.objects.has(second!)).toBe(true);

    const sharp = (await import('sharp')).default;
    const meta = await sharp(mem.objects.get(second!)!.body).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);

    await clearFaviconAdmin(t.db, owner(), mem.storage);
    expect(await getFaviconKey(t.db)).toBeNull();
    expect(await getFaviconUrl(t.db)).toBe(DEFAULT_FAVICON);
    expect(mem.objects.size).toBe(0);
  });

  it('needs settings.manage: a manager cannot change the site icon', async () => {
    const mem = memoryStorage();
    await expect(
      setFaviconAdmin(t.db, manager(), mem.storage, await pngBytes()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mem.objects.size).toBe(0);
  });
});

describe('home slider slides', () => {
  it('keeps slides separate from collection banners, with their own text and order', async () => {
    const mem = memoryStorage();
    const bytes = await pngBytes(1600, 900);
    const make = (alt: string, extra: Record<string, string> = {}) =>
      uploadBannerAdmin(t.db, manager(), mem.storage, { bytes, alt, ...extra });

    const a = await make('Slide A', {
      placement: 'hero',
      heading: 'NEW DROP',
      body: 'Fresh pieces',
      ctaLabel: 'SHOP NOW',
      linkUrl: '/collections/new-in',
    });
    const b = await make('Slide B', { placement: 'hero' });
    await make('Strip', { placement: 'collection' });

    const hero = await listActiveBanners(t.db, 'hero');
    expect(hero.map((s) => s.alt)).toEqual(['Slide A', 'Slide B']);
    expect(hero[0]).toMatchObject({
      heading: 'NEW DROP',
      body: 'Fresh pieces',
      ctaLabel: 'SHOP NOW',
    });
    expect((await listActiveBanners(t.db, 'collection')).map((s) => s.alt)).toEqual(['Strip']);

    // Moving a slide up only trades places with another slide, never with the collection banner.
    await moveBannerAdmin(t.db, manager(), b.id, 'up');
    expect((await listActiveBanners(t.db, 'hero')).map((s) => s.alt)).toEqual([
      'Slide B',
      'Slide A',
    ]);
    expect((await listActiveBanners(t.db, 'collection')).map((s) => s.alt)).toEqual(['Strip']);

    await updateBannerAdmin(t.db, manager(), a.id, { heading: 'CHANGED', ctaLabel: '' });
    const after = (await listActiveBanners(t.db, 'hero')).find((s) => s.alt === 'Slide A');
    expect(after).toMatchObject({ heading: 'CHANGED', ctaLabel: null });

    await expect(make('x', { placement: 'sidebar' })).rejects.toThrow();
    await expect(make('x', { placement: 'hero', heading: 'h'.repeat(121) })).rejects.toThrow();

    for (const row of await listBannersAdmin(t.db, manager())) {
      await deleteBannerAdmin(t.db, manager(), mem.storage, row.id);
    }
  });
});

import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { siteBanner, storeSetting } from '@/db/platform-schema';
import { BANNER_PLACEMENTS, BRAND_SETTING_KEY, getFaviconKey } from '@/lib/banners';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import { newMediaKey, processImageUpload, type ObjectStorage } from '@/modules/catalog';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';

const FAVICON_EDGE_PX = 256;
const MAX_BANNERS = 20;

/** A click target: a path on this site or an https address. Anything else (javascript:, data:, //host) is refused. */
const linkInput = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === '' || (v.startsWith('/') && !v.startsWith('//')) || /^https:\/\/\S+$/.test(v),
    {
      message: 'Enter a path such as /collections/new-in or an https:// address',
    },
  )
  .transform((v) => (v === '' ? null : v));

const altInput = z.string().trim().min(1, 'Describe the image in a few words').max(200);
const placementInput = z.enum(BANNER_PLACEMENTS);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .transform((v) => (v === '' ? null : v));
const headingInput = optionalText(120);
const bodyInput = optionalText(300);
const ctaInput = optionalText(30);

export type AdminBanner = {
  id: string;
  objectKey: string;
  alt: string;
  linkUrl: string | null;
  placement: string;
  heading: string | null;
  body: string | null;
  ctaLabel: string | null;
  width: number;
  height: number;
  position: number;
  active: boolean;
};

export async function listBannersAdmin(db: Db, actor: AdminActor): Promise<AdminBanner[]> {
  assertCan(actor, 'catalog.edit');
  return db
    .select({
      id: siteBanner.id,
      objectKey: siteBanner.objectKey,
      alt: siteBanner.alt,
      linkUrl: siteBanner.linkUrl,
      placement: siteBanner.placement,
      heading: siteBanner.heading,
      body: siteBanner.body,
      ctaLabel: siteBanner.ctaLabel,
      width: siteBanner.width,
      height: siteBanner.height,
      position: siteBanner.position,
      active: siteBanner.active,
    })
    .from(siteBanner)
    .orderBy(asc(siteBanner.position), asc(siteBanner.createdAt));
}

export async function uploadBannerAdmin(
  db: Db,
  actor: AdminActor,
  storage: ObjectStorage,
  input: {
    bytes: Uint8Array;
    alt: string;
    linkUrl?: string;
    placement?: string;
    heading?: string;
    body?: string;
    ctaLabel?: string;
  },
): Promise<{ id: string }> {
  assertCan(actor, 'catalog.edit');
  const alt = altInput.parse(input.alt);
  const linkUrl = linkInput.parse(input.linkUrl ?? '');
  const placement = placementInput.parse(input.placement ?? 'collection');
  const heading = headingInput.parse(input.heading ?? '');
  const body = bodyInput.parse(input.body ?? '');
  const ctaLabel = ctaInput.parse(input.ctaLabel ?? '');
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(siteBanner);
  if ((count?.n ?? 0) >= MAX_BANNERS)
    throw new AppError('VALIDATION_FAILED', `At most ${MAX_BANNERS} banners.`);

  const image = await processImageUpload(input.bytes);
  const key = newMediaKey('banners');
  await storage.put(key, image.data, image.contentType);
  try {
    return await db.transaction(async (tx) => {
      const [pos] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${siteBanner.position}), -1)::int` })
        .from(siteBanner);
      const [row] = await tx
        .insert(siteBanner)
        .values({
          objectKey: key,
          alt,
          linkUrl,
          placement,
          heading,
          body,
          ctaLabel,
          width: image.width,
          height: image.height,
          position: (pos?.max ?? -1) + 1,
        })
        .returning({ id: siteBanner.id });
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: 'banner.create',
        entity: 'banner',
        entityId: row!.id,
        after: {
          objectKey: key,
          alt,
          linkUrl,
          placement,
          heading,
          body,
          ctaLabel,
          width: image.width,
          height: image.height,
        },
      });
      return { id: row!.id };
    });
  } catch (err) {
    await storage.remove(key).catch(() => undefined); // do not leave an orphan file behind
    throw err;
  }
}

export async function updateBannerAdmin(
  db: Db,
  actor: AdminActor,
  id: string,
  patch: {
    alt?: string;
    linkUrl?: string;
    active?: boolean;
    heading?: string;
    body?: string;
    ctaLabel?: string;
  },
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(siteBanner).where(eq(siteBanner.id, id)).for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Banner not found.');
    const next = {
      alt: patch.alt === undefined ? before.alt : altInput.parse(patch.alt),
      linkUrl: patch.linkUrl === undefined ? before.linkUrl : linkInput.parse(patch.linkUrl),
      active: patch.active ?? before.active,
      heading: patch.heading === undefined ? before.heading : headingInput.parse(patch.heading),
      body: patch.body === undefined ? before.body : bodyInput.parse(patch.body),
      ctaLabel: patch.ctaLabel === undefined ? before.ctaLabel : ctaInput.parse(patch.ctaLabel),
    };
    await tx.update(siteBanner).set(next).where(eq(siteBanner.id, id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'banner.update',
      entity: 'banner',
      entityId: id,
      before: {
        alt: before.alt,
        linkUrl: before.linkUrl,
        active: before.active,
        heading: before.heading,
        body: before.body,
        ctaLabel: before.ctaLabel,
      },
      after: next,
    });
  });
}

/** Swap places with the neighbour above or below. */
export async function moveBannerAdmin(
  db: Db,
  actor: AdminActor,
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  await db.transaction(async (tx) => {
    const [self] = await tx.select().from(siteBanner).where(eq(siteBanner.id, id));
    if (!self) throw new AppError('NOT_FOUND', 'Banner not found.');
    // Only banners in the same place (home slider or collection pages) trade places.
    const rows = await tx
      .select({ id: siteBanner.id })
      .from(siteBanner)
      .where(eq(siteBanner.placement, self.placement))
      .orderBy(asc(siteBanner.position), asc(siteBanner.createdAt))
      .for('update');
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw new AppError('NOT_FOUND', 'Banner not found.');
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    const order = rows.map((r) => r.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (const [position, rowId] of order.entries()) {
      await tx.update(siteBanner).set({ position }).where(eq(siteBanner.id, rowId));
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'banner.move',
      entity: 'banner',
      entityId: id,
      after: { direction },
    });
  });
}

export async function deleteBannerAdmin(
  db: Db,
  actor: AdminActor,
  storage: ObjectStorage,
  id: string,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const key = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(siteBanner).where(eq(siteBanner.id, id)).for('update');
    if (!row) throw new AppError('NOT_FOUND', 'Banner not found.');
    await tx.delete(siteBanner).where(eq(siteBanner.id, id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'banner.delete',
      entity: 'banner',
      entityId: id,
      before: { objectKey: row.objectKey, alt: row.alt, linkUrl: row.linkUrl },
    });
    return row.objectKey;
  });
  await storage.remove(key).catch(() => undefined); // the row is gone; a leftover file is harmless
}

/** Replace the site icon (browser tab). The image is re-encoded and shrunk to 256 px. */
export async function setFaviconAdmin(
  db: Db,
  actor: AdminActor,
  storage: ObjectStorage,
  bytes: Uint8Array,
): Promise<void> {
  assertCan(actor, 'settings.manage');
  const image = await processImageUpload(bytes, undefined, FAVICON_EDGE_PX);
  const key = newMediaKey('site');
  await storage.put(key, image.data, image.contentType);
  try {
    const previous = await getFaviconKey(db);
    await db.transaction(async (tx) => {
      await tx
        .insert(storeSetting)
        .values({ key: BRAND_SETTING_KEY, value: { faviconKey: key }, updatedBy: actor.userId })
        .onConflictDoUpdate({
          target: storeSetting.key,
          set: { value: { faviconKey: key }, updatedBy: actor.userId },
        });
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: 'site.favicon_set',
        entity: 'site',
        entityId: BRAND_SETTING_KEY,
        before: { faviconKey: previous },
        after: { faviconKey: key },
      });
    });
    if (previous) await storage.remove(previous).catch(() => undefined);
  } catch (err) {
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
}

/** Go back to the built-in icon. */
export async function clearFaviconAdmin(
  db: Db,
  actor: AdminActor,
  storage: ObjectStorage,
): Promise<void> {
  assertCan(actor, 'settings.manage');
  const previous = await getFaviconKey(db);
  if (!previous) return;
  await db.transaction(async (tx) => {
    await tx
      .insert(storeSetting)
      .values({ key: BRAND_SETTING_KEY, value: { faviconKey: null }, updatedBy: actor.userId })
      .onConflictDoUpdate({
        target: storeSetting.key,
        set: { value: { faviconKey: null }, updatedBy: actor.userId },
      });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'site.favicon_clear',
      entity: 'site',
      entityId: BRAND_SETTING_KEY,
      before: { faviconKey: previous },
    });
  });
  await storage.remove(previous).catch(() => undefined);
}

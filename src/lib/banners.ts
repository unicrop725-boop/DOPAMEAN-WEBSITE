import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { siteBanner, storeSetting } from '@/db/platform-schema';
import { mediaUrl } from '@/modules/catalog';

export type StorefrontBanner = {
  id: string;
  imageUrl: string;
  alt: string;
  linkUrl: string | null;
  heading: string | null;
  body: string | null;
  ctaLabel: string | null;
  width: number;
  height: number;
};

/**
 * 'collection' = between product rows; 'hero' = slides of the home page slider;
 * 'promo' = slides of the second home page slider, under the free-shipping bar;
 * 'shop' = slides at the top of Shop all and the collection pages.
 */
export const BANNER_PLACEMENTS = ['collection', 'hero', 'promo', 'shop'] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

/** Banners shown on the storefront, in the order staff arranged them. Inactive ones never leave the database. */
export async function listActiveBanners(
  db: DbOrTx,
  placement: BannerPlacement = 'collection',
): Promise<StorefrontBanner[]> {
  const rows = await db
    .select()
    .from(siteBanner)
    .where(and(eq(siteBanner.placement, placement), eq(siteBanner.active, true)))
    .orderBy(asc(siteBanner.position), asc(siteBanner.createdAt));
  return rows.map((r) => ({
    id: r.id,
    imageUrl: mediaUrl(r.objectKey),
    alt: r.alt,
    linkUrl: r.linkUrl,
    heading: r.heading,
    body: r.body,
    ctaLabel: r.ctaLabel,
    width: r.width,
    height: r.height,
  }));
}

export const BRAND_SETTING_KEY = 'brand';

/** Object key of the uploaded site icon, or null when none was uploaded (the built-in icon is used then). */
export async function getFaviconKey(db: DbOrTx): Promise<string | null> {
  const [row] = await db
    .select()
    .from(storeSetting)
    .where(eq(storeSetting.key, BRAND_SETTING_KEY))
    .limit(1);
  const key = (row?.value as { faviconKey?: unknown } | undefined)?.faviconKey;
  return typeof key === 'string' ? key : null;
}

export const DEFAULT_FAVICON = '/favicon.png';

export async function getFaviconUrl(db: DbOrTx): Promise<string> {
  const key = await getFaviconKey(db);
  return key ? mediaUrl(key) : DEFAULT_FAVICON;
}

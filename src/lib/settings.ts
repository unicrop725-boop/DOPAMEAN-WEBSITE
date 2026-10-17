import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { storeSetting } from '@/db/platform-schema';
import type { PricingSettings } from '@/modules/pricing';

/**
 * Store configuration edited by the Owner in the admin. Money is integer paise.
 * Defaults mirror what the original site already promises: free shipping on all orders and cash on delivery.
 */
export const storeSettingsSchema = z.object({
  storeName: z.string().trim().min(1).max(80).default('DOPAMEAN'),
  contactEmail: z.string().trim().email().max(254).nullable().default(null),
  /** Seller GSTIN (printed on invoices). Empty until the owner provides it. */
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 characters')
    .nullable()
    .default(null),
  /** GST state code of the seller (Haryana = 06). Decides CGST+SGST versus IGST. */
  sellerStateCode: z
    .string()
    .regex(/^\d{2}$/)
    .default('06'),
  shippingFlatPaise: z.number().int().min(0).max(10_000_000).default(9_900),
  /** Free shipping at or above this subtotal. 0 means shipping is free on every order. */
  freeShippingThresholdPaise: z.number().int().min(0).max(100_000_000).default(0),
  codEnabled: z.boolean().default(true),
  codMaxPaise: z.number().int().min(0).max(100_000_000).default(500_000),
  codFeePaise: z.number().int().min(0).max(1_000_000).default(0),
});
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

const KEY = 'store';

export const DEFAULT_SETTINGS: StoreSettings = storeSettingsSchema.parse({});

/** Current settings: stored values merged over the defaults. Invalid stored values fall back to defaults. */
export async function getSettings(db: DbOrTx): Promise<StoreSettings> {
  const [row] = await db.select().from(storeSetting).where(eq(storeSetting.key, KEY)).limit(1);
  if (!row) return DEFAULT_SETTINGS;
  const merged = storeSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(row.value as object) });
  return merged.success ? merged.data : DEFAULT_SETTINGS;
}

export async function updateSettings(
  db: DbOrTx,
  patch: Partial<StoreSettings>,
  actorUserId: string,
): Promise<{ before: StoreSettings; after: StoreSettings }> {
  const before = await getSettings(db);
  const after = storeSettingsSchema.parse({ ...before, ...patch });
  await db
    .insert(storeSetting)
    .values({ key: KEY, value: after, updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: storeSetting.key,
      set: { value: after, updatedBy: actorUserId },
    });
  return { before, after };
}

export function toPricingSettings(s: StoreSettings): PricingSettings {
  return {
    sellerStateCode: s.sellerStateCode,
    shippingFlatPaise: s.shippingFlatPaise,
    freeShippingThresholdPaise: s.freeShippingThresholdPaise,
    codEnabled: s.codEnabled,
    codMaxPaise: s.codMaxPaise,
    codFeePaise: s.codFeePaise,
  };
}

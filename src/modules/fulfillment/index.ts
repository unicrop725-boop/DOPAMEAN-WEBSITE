import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { shipment } from './schema';

export type ShipmentRow = typeof shipment.$inferSelect;

export const CARRIERS = [
  'Delhivery',
  'Blue Dart',
  'DTDC',
  'India Post',
  'Ecom Express',
  'XpressBees',
  'Other',
] as const;

export const shipInput = z.object({
  carrier: z.string().trim().min(2).max(60),
  trackingNo: z
    .string()
    .trim()
    .min(4, 'Enter the tracking number')
    .max(60)
    .regex(/^[A-Za-z0-9 _./-]+$/, 'Tracking number has invalid characters'),
  trackingUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith('https://'), 'Tracking link must be https')
    .optional(),
});
export type ShipInput = z.input<typeof shipInput>;

/** Record that an order left the warehouse (tracking number entered by hand in R1). */
export async function createShipment(
  tx: DbOrTx,
  orderId: string,
  raw: ShipInput,
  createdBy?: string,
): Promise<ShipmentRow> {
  const input = shipInput.parse(raw);
  const [row] = await tx
    .insert(shipment)
    .values({ orderId, ...input, createdBy })
    .returning();
  if (!row) throw new Error('shipment insert failed');
  return row;
}

export async function markShipmentsDelivered(tx: DbOrTx, orderId: string): Promise<void> {
  const res = await tx
    .update(shipment)
    .set({ deliveredAt: sql`now()` })
    .where(eq(shipment.orderId, orderId))
    .returning({ id: shipment.id });
  if (res.length === 0) throw new AppError('NOT_FOUND', 'no shipment to mark delivered');
}

export async function listShipments(db: DbOrTx, orderId: string): Promise<ShipmentRow[]> {
  return db
    .select()
    .from(shipment)
    .where(eq(shipment.orderId, orderId))
    .orderBy(asc(shipment.shippedAt));
}

import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import {
  addToCart,
  getCartLines,
  removeLine,
  setLineQty,
  type CartOwner,
  MAX_LINE_QTY,
} from '@/modules/cart';
import { getPurchasableVariants, mediaUrl } from '@/modules/catalog';
import { quoteCart } from '@/modules/checkout';
import { Money, formatBracketPrice } from '@/modules/pricing';

export const variantIdSchema = z.uuid();

export type CartViewLine = {
  variantId: string;
  productSlug: string;
  name: string;
  optionLabel: string;
  imageUrl: string | null;
  unitLabel: string;
  qty: number;
  lineTotalLabel: string;
  available: number;
  /** False when the quantity in the cart exceeds what can be sold right now. */
  inStock: boolean;
  maxQty: number;
};

export type CartView = {
  lines: CartViewLine[];
  count: number;
  /** Cart lines whose product is no longer sold; they are dropped from the totals and listed here. */
  removedCount: number;
  subtotalLabel: string;
  shippingLabel: string;
  taxLabel: string;
  totalLabel: string;
  hasBlockingIssue: boolean;
  /** Set when shipping is not free yet: how much more to spend. */
  freeShippingNote: string | null;
};

const label = (paise: number) => formatBracketPrice(Money.of(paise));

/** The cart as the customer sees it: every figure computed from the database, never stored on the cart. */
export async function getCartView(
  db: DbOrTx,
  secret: string,
  owner: CartOwner | null,
): Promise<CartView> {
  if (!owner) {
    return {
      lines: [],
      count: 0,
      removedCount: 0,
      subtotalLabel: label(0),
      shippingLabel: label(0),
      taxLabel: label(0),
      totalLabel: label(0),
      hasBlockingIssue: false,
      freeShippingNote: null,
    };
  }
  const cq = await quoteCart(db, secret, owner, { paymentMethod: 'online' });
  const q = cq.quote;
  const slugs = await getPurchasableVariants(
    db,
    q.lines.map((l) => l.variantId),
  );
  const lines: CartViewLine[] = q.lines.map((l) => ({
    variantId: l.variantId,
    productSlug: slugs.get(l.variantId)?.productSlug ?? '',
    name: l.name,
    optionLabel: l.optionLabel,
    imageUrl: l.imageKey ? mediaUrl(l.imageKey) : null,
    unitLabel: label(l.unitPaise),
    qty: l.qty,
    lineTotalLabel: label(l.totalPaise),
    available: l.available,
    inStock: l.available >= l.qty,
    maxQty: Math.max(0, Math.min(MAX_LINE_QTY, l.available)),
  }));
  const threshold = cq.settings.freeShippingThresholdPaise;
  const freeShippingNote =
    threshold > 0 && q.shippingPaise > 0
      ? `Add ${label(threshold - q.subtotalPaise)} more for free shipping`
      : null;
  return {
    lines,
    count: lines.reduce((n, l) => n + l.qty, 0),
    removedCount: cq.removedVariantIds.length,
    subtotalLabel: label(q.subtotalPaise),
    shippingLabel: q.shippingPaise === 0 ? 'FREE' : label(q.shippingPaise),
    taxLabel: label(q.taxPaise),
    totalLabel: label(q.totalPaise),
    hasBlockingIssue:
      q.issues.some((i) => i.code === 'OUT_OF_STOCK') || cq.removedVariantIds.length > 0,
    freeShippingNote,
  };
}

/** Validate that `qty` units of the variant can be sold now, then add them (summed with what is already there). */
export async function addItem(
  db: DbOrTx,
  owner: CartOwner,
  variantId: string,
  qty: number,
): Promise<number> {
  const id = variantIdSchema.parse(variantId);
  const found = (await getPurchasableVariants(db, [id])).get(id);
  if (!found) throw new AppError('PRODUCT_UNAVAILABLE', 'this item is no longer available');
  if (found.available <= 0)
    throw new AppError('OUT_OF_STOCK', 'this size is sold out', { available: 0 });
  const current = (await getCartLines(db, owner)).find((l) => l.variantId === id)?.qty ?? 0;
  if (current + qty > Math.min(found.available, MAX_LINE_QTY)) {
    throw new AppError(
      'QTY_EXCEEDS_AVAILABLE',
      `only ${Math.min(found.available, MAX_LINE_QTY)} available`,
      {
        available: Math.min(found.available, MAX_LINE_QTY),
        inCart: current,
      },
    );
  }
  return addToCart(db, owner, id, qty);
}

/** Set an exact quantity (0 removes), validated against current stock. */
export async function setItemQty(
  db: DbOrTx,
  owner: CartOwner,
  variantId: string,
  qty: number,
): Promise<void> {
  const id = variantIdSchema.parse(variantId);
  if (qty > 0) {
    const found = (await getPurchasableVariants(db, [id])).get(id);
    if (!found) throw new AppError('PRODUCT_UNAVAILABLE', 'this item is no longer available');
    const cap = Math.min(found.available, MAX_LINE_QTY);
    if (qty > cap) {
      throw new AppError(
        cap === 0 ? 'OUT_OF_STOCK' : 'QTY_EXCEEDS_AVAILABLE',
        `only ${cap} available`,
        { available: cap },
      );
    }
  }
  await setLineQty(db, owner, id, qty);
}

export async function removeItem(db: DbOrTx, owner: CartOwner, variantId: string): Promise<void> {
  await removeLine(db, owner, variantIdSchema.parse(variantId));
}

export async function cartCount(db: DbOrTx, owner: CartOwner | null): Promise<number> {
  if (!owner) return 0;
  return (await getCartLines(db, owner)).reduce((n, l) => n + l.qty, 0);
}

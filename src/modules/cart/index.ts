import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { AppError } from '@/lib/errors';
import { cart, cartLine } from './schema';

/** Who owns a cart: a signed-in customer, or an anonymous browser identified by a secret token. */
export type CartOwner = { customerId: string } | { anonToken: string };

export const MAX_LINE_QTY = 10;
export const MAX_LINES = 30;

export function newAnonToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ownerWhere = (owner: CartOwner) =>
  'customerId' in owner
    ? eq(cart.customerId, owner.customerId)
    : eq(cart.anonTokenHash, hashToken(owner.anonToken));

async function findCart(db: DbOrTx, owner: CartOwner) {
  const [row] = await db.select().from(cart).where(ownerWhere(owner)).limit(1);
  return row ?? null;
}

async function ensureCart(db: DbOrTx, owner: CartOwner): Promise<string> {
  const existing = await findCart(db, owner);
  if (existing) return existing.id;
  const values =
    'customerId' in owner
      ? { customerId: owner.customerId }
      : { anonTokenHash: hashToken(owner.anonToken) };
  const [row] = await db
    .insert(cart)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: cart.id });
  if (row) return row.id;
  const again = await findCart(db, owner); // lost a creation race: the other request made it
  if (!again) throw new Error('cart creation failed');
  return again.id;
}

export type CartLineRow = { variantId: string; qty: number };

export async function getCartLines(db: DbOrTx, owner: CartOwner): Promise<CartLineRow[]> {
  const c = await findCart(db, owner);
  if (!c) return [];
  return db
    .select({ variantId: cartLine.variantId, qty: cartLine.qty })
    .from(cartLine)
    .where(eq(cartLine.cartId, c.id))
    .orderBy(asc(cartLine.addedAt), asc(cartLine.id));
}

/** Add `qty` of a variant (summed with what is already there, capped at MAX_LINE_QTY). Returns the new quantity. */
export async function addToCart(
  db: DbOrTx,
  owner: CartOwner,
  variantId: string,
  qty: number,
): Promise<number> {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY)
    throw new AppError('VALIDATION_FAILED', 'qty');
  const cartId = await ensureCart(db, owner);
  const lines = await db
    .select({ id: cartLine.id })
    .from(cartLine)
    .where(eq(cartLine.cartId, cartId));
  if (lines.length >= MAX_LINES) {
    const has = await db
      .select({ id: cartLine.id })
      .from(cartLine)
      .where(and(eq(cartLine.cartId, cartId), eq(cartLine.variantId, variantId)));
    if (has.length === 0) throw new AppError('VALIDATION_FAILED', 'cart is full');
  }
  const [row] = await db
    .insert(cartLine)
    .values({ cartId, variantId, qty })
    .onConflictDoUpdate({
      target: [cartLine.cartId, cartLine.variantId],
      set: { qty: sql`LEAST(${MAX_LINE_QTY}, ${cartLine.qty} + ${qty})` },
    })
    .returning({ qty: cartLine.qty });
  await db
    .update(cart)
    .set({ updatedAt: sql`now()` })
    .where(eq(cart.id, cartId));
  return row?.qty ?? qty;
}

/** Set an exact quantity; 0 removes the line. */
export async function setLineQty(
  db: DbOrTx,
  owner: CartOwner,
  variantId: string,
  qty: number,
): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_LINE_QTY)
    throw new AppError('VALIDATION_FAILED', 'qty');
  const c = await findCart(db, owner);
  if (!c) return;
  if (qty === 0) {
    await db
      .delete(cartLine)
      .where(and(eq(cartLine.cartId, c.id), eq(cartLine.variantId, variantId)));
  } else {
    await db
      .update(cartLine)
      .set({ qty })
      .where(and(eq(cartLine.cartId, c.id), eq(cartLine.variantId, variantId)));
  }
  await db
    .update(cart)
    .set({ updatedAt: sql`now()` })
    .where(eq(cart.id, c.id));
}

export async function removeLine(db: DbOrTx, owner: CartOwner, variantId: string): Promise<void> {
  await setLineQty(db, owner, variantId, 0);
}

export async function clearCart(db: DbOrTx, owner: CartOwner): Promise<void> {
  const c = await findCart(db, owner);
  if (c) await db.delete(cartLine).where(eq(cartLine.cartId, c.id));
}

/**
 * On sign-in: move the anonymous cart's lines into the customer's cart (same variant: quantities add up,
 * capped) and delete the anonymous cart. Atomic.
 */
export async function mergeAnonymousCart(
  db: Db,
  anonToken: string,
  customerId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the guest cart first: two requests merging at once (the page and the bag-count call) must not both
    // add its lines. The second one waits, then finds the cart already gone and does nothing.
    const [anon] = await tx
      .select()
      .from(cart)
      .where(ownerWhere({ anonToken }))
      .limit(1)
      .for('update');
    if (!anon) return;
    const lines = await tx.select().from(cartLine).where(eq(cartLine.cartId, anon.id));
    if (lines.length > 0) {
      const target = await ensureCart(tx, { customerId });
      for (const l of lines) {
        await tx
          .insert(cartLine)
          .values({ cartId: target, variantId: l.variantId, qty: l.qty })
          .onConflictDoUpdate({
            target: [cartLine.cartId, cartLine.variantId],
            set: { qty: sql`LEAST(${MAX_LINE_QTY}, ${cartLine.qty} + ${l.qty})` },
          });
      }
      await tx
        .update(cart)
        .set({ updatedAt: sql`now()` })
        .where(eq(cart.id, target));
    }
    await tx.delete(cart).where(eq(cart.id, anon.id));
  });
}

export async function countCartItems(db: DbOrTx, owner: CartOwner): Promise<number> {
  const lines = await getCartLines(db, owner);
  return lines.reduce((n, l) => n + l.qty, 0);
}

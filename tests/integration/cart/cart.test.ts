import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cart, user } from '@/db/schema';
import {
  MAX_LINES,
  MAX_LINE_QTY,
  addToCart,
  clearCart,
  countCartItems,
  getCartLines,
  hashToken,
  mergeAnonymousCart,
  newAnonToken,
  removeLine,
  setLineQty,
} from '@/modules/cart';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
  await t.db.insert(user).values({ id: 'cust', name: 'C', email: 'c@example.test' });
});
afterAll(async () => {
  await t.close();
});

const id = () => crypto.randomUUID();
const anon = () => ({ anonToken: newAnonToken() });

describe('cart', () => {
  it('adds, sums repeated adds, and caps a line at the maximum quantity', async () => {
    const o = anon();
    const v = id();
    expect(await addToCart(t.db, o, v, 2)).toBe(2);
    expect(await addToCart(t.db, o, v, 3)).toBe(5);
    expect(await addToCart(t.db, o, v, MAX_LINE_QTY)).toBe(MAX_LINE_QTY);
    expect(await getCartLines(t.db, o)).toEqual([{ variantId: v, qty: MAX_LINE_QTY }]);
  });

  it('rejects invalid quantities', async () => {
    const o = anon();
    for (const bad of [0, -1, 1.5, MAX_LINE_QTY + 1]) {
      await expect(addToCart(t.db, o, id(), bad)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(setLineQty(t.db, o, id(), -1)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('sets exact quantities, removes with 0, removes lines and clears the cart', async () => {
    const o = anon();
    const [a, b] = [id(), id()];
    await addToCart(t.db, o, a, 1);
    await addToCart(t.db, o, b, 1);
    await setLineQty(t.db, o, a, 4);
    expect((await getCartLines(t.db, o)).find((l) => l.variantId === a)?.qty).toBe(4);
    await setLineQty(t.db, o, a, 0);
    expect((await getCartLines(t.db, o)).map((l) => l.variantId)).toEqual([b]);
    await removeLine(t.db, o, b);
    expect(await getCartLines(t.db, o)).toEqual([]);
    await addToCart(t.db, o, a, 2);
    await clearCart(t.db, o);
    expect(await getCartLines(t.db, o)).toEqual([]);
  });

  it('an unknown cart is simply empty (no error, nothing created by reading)', async () => {
    const o = anon();
    expect(await getCartLines(t.db, o)).toEqual([]);
    expect(await countCartItems(t.db, o)).toBe(0);
    expect(
      await t.db
        .select()
        .from(cart)
        .where(eq(cart.anonTokenHash, hashToken(o.anonToken))),
    ).toHaveLength(0);
  });

  it('stores only a hash of the anonymous token, never the token itself', async () => {
    const o = anon();
    await addToCart(t.db, o, id(), 1);
    const rows = await t.db.select().from(cart);
    expect(rows.some((r) => r.anonTokenHash === o.anonToken)).toBe(false);
    expect(rows.some((r) => r.anonTokenHash === hashToken(o.anonToken))).toBe(true);
  });

  it('carts are isolated: one visitor cannot see or change another', async () => {
    const [a, b] = [anon(), anon()];
    const v = id();
    await addToCart(t.db, a, v, 3);
    expect(await getCartLines(t.db, b)).toEqual([]);
    await removeLine(t.db, b, v);
    expect((await getCartLines(t.db, a))[0]?.qty).toBe(3);
  });

  it('concurrent adds from the same visitor add up exactly', async () => {
    const o = anon();
    const v = id();
    await Promise.all(Array.from({ length: 6 }, () => addToCart(t.db, o, v, 1)));
    expect((await getCartLines(t.db, o))[0]?.qty).toBe(6);
  });

  it('limits the number of distinct lines', async () => {
    const o = anon();
    for (let i = 0; i < MAX_LINES; i++) await addToCart(t.db, o, id(), 1);
    await expect(addToCart(t.db, o, id(), 1)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('merging the guest cart on sign-in', () => {
  it('moves guest lines into the customer cart, sums shared variants (capped) and deletes the guest cart', async () => {
    const guest = anon();
    const customer = { customerId: 'cust' };
    const [shared, onlyGuest, onlyCustomer] = [id(), id(), id()];
    await addToCart(t.db, guest, shared, 4);
    await addToCart(t.db, guest, onlyGuest, 1);
    await addToCart(t.db, customer, shared, 8);
    await addToCart(t.db, customer, onlyCustomer, 2);

    await mergeAnonymousCart(t.db, guest.anonToken, 'cust');

    const lines = Object.fromEntries(
      (await getCartLines(t.db, customer)).map((l) => [l.variantId, l.qty]),
    );
    expect(lines).toEqual({ [shared]: MAX_LINE_QTY, [onlyGuest]: 1, [onlyCustomer]: 2 });
    expect(await getCartLines(t.db, guest)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(cart)
        .where(eq(cart.anonTokenHash, hashToken(guest.anonToken))),
    ).toHaveLength(0);
  });

  it('creates the customer cart when they had none, and merging twice is harmless', async () => {
    await t.db.insert(user).values({ id: 'cust2', name: 'D', email: 'd@example.test' });
    const guest = anon();
    const v = id();
    await addToCart(t.db, guest, v, 2);
    await mergeAnonymousCart(t.db, guest.anonToken, 'cust2');
    await mergeAnonymousCart(t.db, guest.anonToken, 'cust2');
    expect(await getCartLines(t.db, { customerId: 'cust2' })).toEqual([{ variantId: v, qty: 2 }]);
  });

  it('merging at the same moment from several requests adds the guest lines exactly once', async () => {
    await t.db.insert(user).values({ id: 'cust3', name: 'E', email: 'e@example.test' });
    const guest = anon();
    const v = id();
    await addToCart(t.db, guest, v, 1);
    // The page render and the bag-count call both merge when a guest signs in; they race.
    await Promise.all(
      Array.from({ length: 6 }, () => mergeAnonymousCart(t.db, guest.anonToken, 'cust3')),
    );
    expect(await getCartLines(t.db, { customerId: 'cust3' })).toEqual([{ variantId: v, qty: 1 }]);
  });

  it('merging with no guest cart does nothing', async () => {
    await expect(mergeAnonymousCart(t.db, newAnonToken(), 'cust')).resolves.toBeUndefined();
  });
});

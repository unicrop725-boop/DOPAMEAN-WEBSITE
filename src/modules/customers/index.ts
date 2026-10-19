import { and, count, desc, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { account, session, twoFactor, user } from '@/db/auth-schema';
import { AppError } from '@/lib/errors';
import { address, customerProfile } from './schema';
import {
  addressInput,
  MAX_ADDRESSES_PER_CUSTOMER,
  type AddressFormInput,
  type AddressInput,
} from './domain/address';

export { GST_STATES, isGstStateCode, stateName } from './domain/states';
export { addressInput, indianMobile, MAX_ADDRESSES_PER_CUSTOMER } from './domain/address';
export type { AddressInput, AddressFormInput } from './domain/address';

/** Create the customer profile for a freshly registered user. Idempotent. */
export async function ensureCustomerProfile(tx: DbOrTx, userId: string): Promise<void> {
  await tx.insert(customerProfile).values({ userId }).onConflictDoNothing();
}

/** Addresses of one customer, default first. The owner id is part of every predicate (INV-13). */
export async function listAddresses(db: DbOrTx, customerId: string) {
  return db
    .select()
    .from(address)
    .where(eq(address.customerId, customerId))
    .orderBy(desc(address.isDefault), desc(address.createdAt));
}

export async function getAddress(db: DbOrTx, customerId: string, addressId: string) {
  const [row] = await db
    .select()
    .from(address)
    .where(and(eq(address.id, addressId), eq(address.customerId, customerId)))
    .limit(1);
  return row ?? null;
}

export type AddressRow = NonNullable<Awaited<ReturnType<typeof getAddress>>>;

async function clearDefault(tx: DbOrTx, customerId: string) {
  await tx.update(address).set({ isDefault: false }).where(eq(address.customerId, customerId));
}

/** Validates, enforces the per-customer limit, and keeps exactly one default address. */
export async function createAddress(
  db: Db,
  customerId: string,
  raw: AddressFormInput,
): Promise<AddressRow> {
  const input = addressInput.parse(raw);
  return db.transaction(async (tx) => {
    const [n] = await tx
      .select({ n: count() })
      .from(address)
      .where(eq(address.customerId, customerId));
    const existing = n?.n ?? 0;
    if (existing >= MAX_ADDRESSES_PER_CUSTOMER) {
      throw new AppError(
        'VALIDATION_FAILED',
        `You can save up to ${MAX_ADDRESSES_PER_CUSTOMER} addresses`,
      );
    }
    const makeDefault = input.isDefault || existing === 0;
    if (makeDefault) await clearDefault(tx, customerId);
    const [row] = await tx
      .insert(address)
      .values({ ...input, customerId, isDefault: makeDefault })
      .returning();
    if (!row) throw new Error('address insert failed');
    return row;
  });
}

/** Update an address the caller owns. Another customer's id matches nothing and yields NOT_FOUND. */
export async function updateAddress(
  db: Db,
  customerId: string,
  addressId: string,
  raw: AddressFormInput,
): Promise<AddressRow> {
  const input: AddressInput = addressInput.parse(raw);
  return db.transaction(async (tx) => {
    if (input.isDefault) await clearDefault(tx, customerId);
    const [row] = await tx
      .update(address)
      .set(input)
      .where(and(eq(address.id, addressId), eq(address.customerId, customerId)))
      .returning();
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  });
}

export async function deleteAddress(db: Db, customerId: string, addressId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(address)
      .where(and(eq(address.id, addressId), eq(address.customerId, customerId)))
      .returning();
    if (!removed) throw new AppError('NOT_FOUND');
    if (removed.isDefault) {
      // Promote the newest remaining address so a default always exists.
      const [next] = await tx
        .select({ id: address.id })
        .from(address)
        .where(eq(address.customerId, customerId))
        .orderBy(desc(address.createdAt))
        .limit(1);
      if (next) await tx.update(address).set({ isDefault: true }).where(eq(address.id, next.id));
    }
  });
}

export async function setDefaultAddress(
  db: Db,
  customerId: string,
  addressId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const found = await getAddress(tx, customerId, addressId);
    if (!found) throw new AppError('NOT_FOUND');
    await clearDefault(tx, customerId);
    await tx.update(address).set({ isDefault: true }).where(eq(address.id, addressId));
  });
}

export type CustomerExport = {
  exportedAt: string;
  account: { id: string; name: string; email: string; emailVerified: boolean; createdAt: string };
  profile: { phone: string | null; marketingOptIn: boolean } | null;
  addresses: Omit<AddressRow, 'customerId'>[];
};

/** Everything we hold about one customer (data export, brief §9). More sections join as modules land. */
export async function exportCustomerData(db: DbOrTx, userId: string): Promise<CustomerExport> {
  const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!u) throw new AppError('NOT_FOUND');
  const [profile] = await db
    .select()
    .from(customerProfile)
    .where(eq(customerProfile.userId, userId))
    .limit(1);
  const addresses = (await listAddresses(db, userId)).map(({ customerId: _c, ...rest }) => rest);
  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: u.id,
      name: u.name,
      email: u.email,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt.toISOString(),
    },
    profile: profile ? { phone: profile.phone, marketingOptIn: profile.marketingOptIn } : null,
    addresses,
  };
}

/**
 * Delete a customer account: remove sign-in ability and personal data, keep the (anonymised) user row so
 * records we must retain by law (orders and invoices, added later) keep a valid reference. Brief §9.
 */
export async function anonymizeCustomer(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
    if (!u) throw new AppError('NOT_FOUND');
    await tx.delete(address).where(eq(address.customerId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx
      .update(user)
      .set({
        name: 'Deleted customer',
        email: `deleted-${userId}@invalid.example`,
        emailVerified: false,
        image: null,
        twoFactorEnabled: false,
      })
      .where(eq(user.id, userId));
    await tx
      .update(customerProfile)
      .set({ phone: null, marketingOptIn: false, deletedAt: new Date() })
      .where(eq(customerProfile.userId, userId));
  });
}

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, address, customerProfile, session, user } from '@/db/schema';
import {
  anonymizeCustomer,
  createAddress,
  deleteAddress,
  ensureCustomerProfile,
  exportCustomerData,
  listAddresses,
  setDefaultAddress,
  updateAddress,
} from '@/modules/customers';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
  for (const id of ['alice', 'bob']) {
    await t.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
    await ensureCustomerProfile(t.db, id);
  }
});
afterAll(async () => {
  await t.close();
});

const input = (over: Record<string, unknown> = {}) => ({
  fullName: 'Asha Verma',
  line1: '12 Test Street',
  city: 'Panipat',
  stateCode: '06',
  pincode: '132103',
  phone: '9876543210',
  ...over,
});

describe('address book rules', () => {
  it('the first address becomes the default; a later default replaces it (exactly one default)', async () => {
    const a1 = await createAddress(t.db, 'alice', input({ line1: 'First' }));
    expect(a1.isDefault).toBe(true);
    const a2 = await createAddress(t.db, 'alice', input({ line1: 'Second', isDefault: true }));
    const rows = await listAddresses(t.db, 'alice');
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([a2.id]);
    expect(rows[0]?.id).toBe(a2.id); // default listed first
  });

  it('deleting the default promotes another address so a default always exists', async () => {
    const rows = await listAddresses(t.db, 'alice');
    const def = rows.find((r) => r.isDefault)!;
    await deleteAddress(t.db, 'alice', def.id);
    const after = await listAddresses(t.db, 'alice');
    expect(after).toHaveLength(1);
    expect(after[0]?.isDefault).toBe(true);
  });

  it('makes another address the default', async () => {
    const extra = await createAddress(t.db, 'alice', input({ line1: 'Third' }));
    await setDefaultAddress(t.db, 'alice', extra.id);
    const rows = await listAddresses(t.db, 'alice');
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(rows.find((r) => r.isDefault)?.id).toBe(extra.id);
  });

  it('updates an address and validates input', async () => {
    const [first] = await listAddresses(t.db, 'alice');
    const updated = await updateAddress(t.db, 'alice', first!.id, input({ city: 'Karnal' }));
    expect(updated.city).toBe('Karnal');
    await expect(
      updateAddress(t.db, 'alice', first!.id, input({ pincode: '1' })),
    ).rejects.toThrow();
  });

  it('limits a customer to 10 saved addresses', async () => {
    const existing = (await listAddresses(t.db, 'bob')).length;
    for (let i = existing; i < 10; i++)
      await createAddress(t.db, 'bob', input({ line1: `Addr ${i}` }));
    await expect(createAddress(t.db, 'bob', input())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('INV-13 (data layer): customers can only touch their own addresses', () => {
  it("bob cannot update, delete or default alice's address; alice's data is unchanged", async () => {
    const [aliceAddr] = await listAddresses(t.db, 'alice');
    const before = JSON.stringify(aliceAddr);
    await expect(
      updateAddress(t.db, 'bob', aliceAddr!.id, input({ city: 'Hacked' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteAddress(t.db, 'bob', aliceAddr!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(setDefaultAddress(t.db, 'bob', aliceAddr!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const [again] = await t.db.select().from(address).where(eq(address.id, aliceAddr!.id));
    expect(JSON.stringify(again)).toBe(before);
  });

  it("alice's export contains only alice's data", async () => {
    const data = await exportCustomerData(t.db, 'alice');
    expect(data.account.email).toBe('alice@example.test');
    expect(data.addresses.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain('bob@example.test');
    expect(data.addresses.every((a) => !('customerId' in a))).toBe(true);
  });
});

describe('account deletion (brief §9: export and deletion)', () => {
  it('removes sign-in, sessions, addresses and personal data; keeps an anonymised user row', async () => {
    await t.db
      .insert(user)
      .values({ id: 'carol', name: 'Carol Real', email: 'carol@example.test' });
    await ensureCustomerProfile(t.db, 'carol');
    await t.db
      .update(customerProfile)
      .set({ phone: '9000000000', marketingOptIn: true })
      .where(eq(customerProfile.userId, 'carol'));
    await t.db.insert(account).values({
      id: 'acc-c',
      accountId: 'carol',
      providerId: 'credential',
      userId: 'carol',
      password: 'hash',
    });
    await t.db.insert(session).values({
      id: 's-c',
      token: 'tok-c',
      userId: 'carol',
      expiresAt: new Date(Date.now() + 1e6),
    });
    await createAddress(t.db, 'carol', input());

    await anonymizeCustomer(t.db, 'carol');

    const [u] = await t.db.select().from(user).where(eq(user.id, 'carol'));
    expect(u?.name).toBe('Deleted customer');
    expect(u?.email).toBe('deleted-carol@invalid.example');
    expect(await t.db.select().from(account).where(eq(account.userId, 'carol'))).toHaveLength(0);
    expect(await t.db.select().from(session).where(eq(session.userId, 'carol'))).toHaveLength(0);
    expect(await listAddresses(t.db, 'carol')).toHaveLength(0);
    const [p] = await t.db
      .select()
      .from(customerProfile)
      .where(eq(customerProfile.userId, 'carol'));
    expect(p?.phone).toBeNull();
    expect(p?.marketingOptIn).toBe(false);
    expect(p?.deletedAt).toBeInstanceOf(Date);
  });

  it('does not touch other customers', async () => {
    const [bob] = await t.db.select().from(user).where(eq(user.id, 'bob'));
    expect(bob?.email).toBe('bob@example.test');
    expect((await listAddresses(t.db, 'bob')).length).toBeGreaterThan(0);
  });

  it('answers NOT_FOUND for an unknown user', async () => {
    await expect(anonymizeCustomer(t.db, 'nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

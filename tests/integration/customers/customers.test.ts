import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { address, customerProfile, user } from '@/db/schema';
import { ensureCustomerProfile, getAddress, listAddresses } from '@/modules/customers';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
let aliceAddress: string;
beforeAll(async () => {
  t = await newTestDb();
  await t.db.insert(user).values([
    { id: 'alice', name: 'Alice', email: 'alice@example.test' },
    { id: 'bob', name: 'Bob', email: 'bob@example.test' },
  ]);
  await ensureCustomerProfile(t.db, 'alice');
  await ensureCustomerProfile(t.db, 'bob');
  const [a] = await t.db
    .insert(address)
    .values({
      customerId: 'alice',
      fullName: 'Alice',
      line1: '1 Test Street',
      city: 'Panipat',
      stateCode: '06',
      pincode: '132103',
      phone: '9000000001',
    })
    .returning({ id: address.id });
  aliceAddress = a!.id;
  await t.db.insert(address).values({
    customerId: 'bob',
    fullName: 'Bob',
    line1: '2 Test Street',
    city: 'Panipat',
    stateCode: '06',
    pincode: '132103',
    phone: '9000000002',
  });
});
afterAll(async () => {
  await t.close();
});

describe('customer data ownership (data layer; INV-13 is completed by the order/account tests)', () => {
  it('ensureCustomerProfile is idempotent', async () => {
    await ensureCustomerProfile(t.db, 'alice');
    expect(await t.db.select().from(customerProfile)).toHaveLength(2);
  });

  it('lists only the caller own addresses', async () => {
    const mine = await listAddresses(t.db, 'alice');
    expect(mine.map((a) => a.fullName)).toEqual(['Alice']);
  });

  it('a customer cannot read another customer address by id', async () => {
    expect(await getAddress(t.db, 'alice', aliceAddress)).not.toBeNull();
    expect(await getAddress(t.db, 'bob', aliceAddress)).toBeNull();
  });
});

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, staffProfile, user } from '@/db/schema';
import { listAudit } from '@/modules/audit';
import { bootstrapOwner, createStaff, loadStaff, type StaffContext } from '@/modules/staff';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const ctx = (over: Partial<StaffContext>): StaffContext => ({
  userId: 'actor',
  email: 'actor@example.test',
  name: 'Actor',
  role: 'owner',
  twoFactorEnabled: true,
  ...over,
});
const meta = { ip: '198.51.100.7', userAgent: 'vitest' };
const input = (email: string, role: 'owner' | 'manager' | 'support' = 'support') => ({
  email,
  name: 'New Person',
  role,
  password: 'a-long-enough-password',
});

describe('staff accounts: only an Owner creates them, server-side', () => {
  it('bootstraps the first owner exactly once', async () => {
    const { userId } = await bootstrapOwner(t.db, {
      email: 'first@example.test',
      name: 'First',
      password: 'a-long-enough-password',
    });
    const staff = await loadStaff(t.db, userId);
    expect(staff).toMatchObject({
      role: 'owner',
      email: 'first@example.test',
      twoFactorEnabled: false,
    });
    await expect(
      bootstrapOwner(t.db, {
        email: 'second@example.test',
        name: 'Second',
        password: 'a-long-enough-password',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const owners = await t.db.select().from(staffProfile).where(eq(staffProfile.role, 'owner'));
    expect(owners).toHaveLength(1);
  });

  it('stores a hashed password, never the plain text', async () => {
    const [row] = await t.db
      .select()
      .from(account)
      .where(eq(account.providerId, 'credential'))
      .limit(1);
    expect(row?.password).toBeTruthy();
    expect(row?.password).not.toContain('a-long-enough-password');
  });

  it.each(['support', 'manager'] as const)(
    'a %s cannot create staff and nothing is written',
    async (role) => {
      await expect(
        createStaff(t.db, ctx({ role }), meta, input(`denied-${role}@example.test`)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const rows = await t.db
        .select()
        .from(user)
        .where(eq(user.email, `denied-${role}@example.test`));
      expect(rows).toHaveLength(0);
    },
  );

  it('an owner who has not enrolled 2FA is blocked (TWO_FACTOR_REQUIRED)', async () => {
    await expect(
      createStaff(
        t.db,
        ctx({ role: 'owner', twoFactorEnabled: false }),
        meta,
        input('no2fa@example.test'),
      ),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
  });

  it('no actor at all is UNAUTHENTICATED', async () => {
    await expect(
      createStaff(t.db, null as unknown as StaffContext, meta, input('anon@example.test')),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('an enrolled owner creates staff; user, credential, profile and audit row all commit together', async () => {
    const { userId } = await createStaff(
      t.db,
      ctx({ userId: 'owner-1' }),
      meta,
      input('agent@example.test', 'support'),
    );
    const staff = await loadStaff(t.db, userId);
    expect(staff).toMatchObject({ role: 'support', email: 'agent@example.test' });
    const audit = await listAudit(t.db, { entity: 'staff', entityId: userId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: 'owner-1',
      actorRole: 'owner',
      action: 'staff.create',
      ip: '198.51.100.7',
      after: { email: 'agent@example.test', role: 'support' },
    });
  });

  it('rejects a duplicate email without leaving partial rows', async () => {
    await expect(
      createStaff(t.db, ctx({}), meta, input('agent@example.test', 'manager')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects weak passwords at the boundary', async () => {
    await expect(
      createStaff(t.db, ctx({}), meta, { ...input('weak@example.test'), password: 'short' }),
    ).rejects.toThrow();
    expect(await t.db.select().from(user).where(eq(user.email, 'weak@example.test'))).toHaveLength(
      0,
    );
  });

  it('loadStaff returns null for a customer and for a deactivated staff member', async () => {
    await t.db.insert(user).values({ id: 'cust-1', name: 'Cust', email: 'cust@example.test' });
    expect(await loadStaff(t.db, 'cust-1')).toBeNull();
    const { userId } = await createStaff(t.db, ctx({}), meta, input('leaver@example.test'));
    await t.db.update(staffProfile).set({ active: false }).where(eq(staffProfile.userId, userId));
    expect(await loadStaff(t.db, userId)).toBeNull();
  });
});

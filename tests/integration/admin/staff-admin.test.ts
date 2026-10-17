import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent, session, staffProfile, user } from '@/db/schema';
import {
  bootstrapOwner,
  changeStaffRole,
  createStaff,
  listStaff,
  listStaffDirectory,
  lookupStaff,
  setStaffActive,
  type AdminActor,
} from '@/modules/staff';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  actorOf,
  auditCount,
  breakAuditFor,
  manager,
  manager2faOff,
  owner2faOff,
  support,
} from '../../support/admin';

let t: TestDb;
let ownerId: string;
let ownerActor: AdminActor;
let managerId: string;
let supportId: string;

beforeAll(async () => {
  t = await newTestDb();
  ownerId = (
    await bootstrapOwner(t.db, {
      email: 'boss@example.test',
      name: 'Boss',
      password: 'a-long-enough-password',
    })
  ).userId;
  ownerActor = actorOf('owner', { userId: ownerId, email: 'boss@example.test' });
  managerId = (
    await createStaff(t.db, ownerActor, ownerActor, {
      email: 'mgr@example.test',
      name: 'Mgr',
      role: 'manager',
      password: 'a-long-enough-password',
    })
  ).userId;
  supportId = (
    await createStaff(t.db, ownerActor, ownerActor, {
      email: 'sup@example.test',
      name: 'Sup',
      role: 'support',
      password: 'a-long-enough-password',
    })
  ).userId;
});
afterAll(async () => {
  await t.close();
});

const roleOf = async (id: string) =>
  (await t.db.select().from(staffProfile).where(eq(staffProfile.userId, id)))[0]!;
const lastAudit = async (action: string, entityId: string) =>
  (
    await t.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action), eq(auditEvent.entityId, entityId)))
  ).at(-1);

describe('staff list', () => {
  it('lists every staff member for an owner, with role, active flag and email', async () => {
    const rows = await listStaff(t.db, ownerActor);
    expect(rows.map((r) => r.email).sort()).toEqual([
      'boss@example.test',
      'mgr@example.test',
      'sup@example.test',
    ]);
    expect(rows.find((r) => r.userId === managerId)).toMatchObject({
      role: 'manager',
      active: true,
    });
  });

  it.each([
    ['manager', manager],
    ['support', support],
  ])('a %s cannot list staff', async (_n, make) => {
    await expect(listStaff(t.db, make())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an owner without 2FA is refused (TWO_FACTOR_REQUIRED)', async () => {
    await expect(listStaff(t.db, owner2faOff())).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });

  it('directory and lookup helpers return names for audit labels', async () => {
    expect((await listStaffDirectory(t.db)).length).toBe(3);
    const found = await lookupStaff(t.db, [managerId, 'nobody']);
    expect(found.get(managerId)?.email).toBe('mgr@example.test');
    expect(found.has('nobody')).toBe(false);
  });
});

describe('change role', () => {
  it('changes the role and writes an audit event with before, after, ip and user agent', async () => {
    await changeStaffRole(t.db, ownerActor, { userId: supportId, role: 'manager' });
    expect((await roleOf(supportId)).role).toBe('manager');
    const a = await lastAudit('staff.change_role', supportId);
    expect(a).toMatchObject({
      actorUserId: ownerId,
      actorRole: 'owner',
      entity: 'staff',
      ip: '203.0.113.9',
      userAgent: 'vitest-admin',
      before: { email: 'sup@example.test', role: 'support' },
      after: { email: 'sup@example.test', role: 'manager' },
    });
    await changeStaffRole(t.db, ownerActor, { userId: supportId, role: 'support' });
  });

  it('refuses changing your own role', async () => {
    await expect(
      changeStaffRole(t.db, ownerActor, { userId: ownerId, role: 'manager' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await roleOf(ownerId)).role).toBe('owner');
  });

  it('refuses demoting the last active owner (even when the caller is not that owner)', async () => {
    const stranger = actorOf('owner'); // an owner context whose row is not in this database
    await expect(
      changeStaffRole(t.db, stranger, { userId: ownerId, role: 'support' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('last active owner'),
    });
    expect((await roleOf(ownerId)).role).toBe('owner');
  });

  it('rejects a no-op change and invalid input; unknown user is NOT_FOUND', async () => {
    await expect(
      changeStaffRole(t.db, ownerActor, { userId: managerId, role: 'manager' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      changeStaffRole(t.db, ownerActor, { userId: managerId, role: 'god' as never }),
    ).rejects.toThrow();
    await expect(
      changeStaffRole(t.db, ownerActor, { userId: 'ghost', role: 'support' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['manager', manager],
    ['support', support],
  ])('a %s cannot change roles and nothing is written', async (_n, make) => {
    const before = await auditCount(t.db);
    await expect(
      changeStaffRole(t.db, make(), { userId: supportId, role: 'owner' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await roleOf(supportId)).role).toBe('support');
    expect(await auditCount(t.db)).toBe(before);
  });

  it('refuses an owner without 2FA', async () => {
    await expect(
      changeStaffRole(t.db, owner2faOff(), { userId: supportId, role: 'manager' }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
  });

  it('rolls the role change back when the audit write fails', async () => {
    const restore = await breakAuditFor(t, 'staff.change_role');
    try {
      await expect(
        changeStaffRole(t.db, ownerActor, { userId: supportId, role: 'manager' }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await roleOf(supportId)).role).toBe('support');
  });

  it('promoting a second owner makes demoting the first possible', async () => {
    const second = (
      await createStaff(t.db, ownerActor, ownerActor, {
        email: 'second-owner@example.test',
        name: 'Second',
        role: 'manager',
        password: 'a-long-enough-password',
      })
    ).userId;
    await changeStaffRole(t.db, ownerActor, { userId: second, role: 'owner' });
    const secondActor = actorOf('owner', { userId: second });
    await changeStaffRole(t.db, secondActor, { userId: ownerId, role: 'manager' });
    expect((await roleOf(ownerId)).role).toBe('manager');
    // put things back for the other tests
    await changeStaffRole(t.db, secondActor, { userId: ownerId, role: 'owner' });
    await changeStaffRole(t.db, ownerActor, { userId: second, role: 'support' });
    await setStaffActive(t.db, ownerActor, { userId: second, active: false });
  });
});

describe('deactivate and reactivate', () => {
  it('deactivates, ends the person sessions, audits, and reactivates', async () => {
    await t.db.insert(session).values({
      id: 'sess-1',
      token: 'tok-1',
      userId: supportId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await setStaffActive(t.db, ownerActor, { userId: supportId, active: false });
    expect((await roleOf(supportId)).active).toBe(false);
    expect(await t.db.select().from(session).where(eq(session.userId, supportId))).toHaveLength(0);
    expect(await lastAudit('staff.deactivate', supportId)).toMatchObject({
      before: { active: true },
      after: { active: false },
    });
    await setStaffActive(t.db, ownerActor, { userId: supportId, active: true });
    expect((await roleOf(supportId)).active).toBe(true);
    expect(await lastAudit('staff.reactivate', supportId)).toMatchObject({
      after: { active: true },
    });
  });

  it('refuses deactivating yourself', async () => {
    await expect(
      setStaffActive(t.db, ownerActor, { userId: ownerId, active: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('your own') });
    expect((await roleOf(ownerId)).active).toBe(true);
  });

  it('refuses deactivating the last active owner', async () => {
    const stranger = actorOf('owner');
    await expect(
      setStaffActive(t.db, stranger, { userId: ownerId, active: false }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('last active owner'),
    });
    expect((await roleOf(ownerId)).active).toBe(true);
  });

  it('is a validation error to repeat the same state; unknown user is NOT_FOUND', async () => {
    await expect(
      setStaffActive(t.db, ownerActor, { userId: managerId, active: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      setStaffActive(t.db, ownerActor, { userId: 'ghost', active: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['manager', manager],
    ['manager without 2FA', manager2faOff],
    ['support', support],
  ])('%s cannot deactivate anyone', async (_n, make) => {
    const before = await auditCount(t.db);
    await expect(
      setStaffActive(t.db, make(), { userId: managerId, active: false }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|TWO_FACTOR_REQUIRED/) });
    expect((await roleOf(managerId)).active).toBe(true);
    expect(await auditCount(t.db)).toBe(before);
  });

  it('a deactivated staff member can no longer be loaded as staff', async () => {
    const { loadStaff } = await import('@/modules/staff');
    await setStaffActive(t.db, ownerActor, { userId: managerId, active: false });
    expect(await loadStaff(t.db, managerId)).toBeNull();
    await setStaffActive(t.db, ownerActor, { userId: managerId, active: true });
    expect(await loadStaff(t.db, managerId)).not.toBeNull();
  });

  it('rolls the deactivation back when the audit write fails (sessions survive too)', async () => {
    await t.db.insert(session).values({
      id: 'sess-2',
      token: 'tok-2',
      userId: managerId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const restore = await breakAuditFor(t, 'staff.deactivate');
    try {
      await expect(
        setStaffActive(t.db, ownerActor, { userId: managerId, active: false }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await roleOf(managerId)).active).toBe(true);
    expect(await t.db.select().from(session).where(eq(session.userId, managerId))).toHaveLength(1);
  });

  it('keeps the user row (no data loss) when deactivated', async () => {
    await setStaffActive(t.db, ownerActor, { userId: supportId, active: false });
    const rows = await t.db.select().from(user).where(eq(user.id, supportId));
    expect(rows).toHaveLength(1);
    await setStaffActive(t.db, ownerActor, { userId: supportId, active: true });
  });
});

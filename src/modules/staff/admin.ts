import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@/db/client';
import { session, user } from '@/db/auth-schema';
import { AppError } from '@/lib/errors';
import { recordAudit, type AuditActor } from '@/modules/audit';
import { ROLES, type Role } from './domain/roles';
import { staffProfile } from './schema';
import { assertCan, type StaffContext } from './service';

/**
 * The signed-in staff member plus the request metadata the audit log records (INV-14).
 * Every admin mutation takes one of these as its second argument and authorizes with it.
 */
export type AdminActor = StaffContext & { ip?: string | null; userAgent?: string | null };

export function auditActorOf(actor: AdminActor): AuditActor {
  return {
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

export type StaffListItem = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
};

/** Everyone with a staff profile, active or not. Owner only. */
export async function listStaff(db: DbOrTx, actor: AdminActor): Promise<StaffListItem[]> {
  assertCan(actor, 'staff.manage');
  const rows = await db
    .select({
      userId: staffProfile.userId,
      email: user.email,
      name: user.name,
      role: staffProfile.role,
      active: staffProfile.active,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: staffProfile.createdAt,
    })
    .from(staffProfile)
    .innerJoin(user, eq(user.id, staffProfile.userId))
    .orderBy(asc(user.email));
  return rows.map((r) => ({ ...r, twoFactorEnabled: r.twoFactorEnabled === true }));
}

/**
 * Name and email for a set of staff ids (audit log "who"). Deliberately has no permission check: it is an
 * internal lookup used by pages that already authorized the viewer for the data being labelled.
 */
export async function lookupStaff(
  db: DbOrTx,
  userIds: string[],
): Promise<Map<string, { email: string; name: string; role: Role; active: boolean }>> {
  const out = new Map<string, { email: string; name: string; role: Role; active: boolean }>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      userId: staffProfile.userId,
      email: user.email,
      name: user.name,
      role: staffProfile.role,
      active: staffProfile.active,
    })
    .from(staffProfile)
    .innerJoin(user, eq(user.id, staffProfile.userId))
    .where(inArray(staffProfile.userId, ids));
  for (const r of rows) out.set(r.userId, r);
  return out;
}

/** Every staff member (id, email, name) for pickers such as the audit-log "actor" filter. */
export async function listStaffDirectory(
  db: DbOrTx,
): Promise<{ userId: string; email: string; name: string }[]> {
  return db
    .select({ userId: staffProfile.userId, email: user.email, name: user.name })
    .from(staffProfile)
    .innerJoin(user, eq(user.id, staffProfile.userId))
    .orderBy(asc(user.email));
}

const changeRoleInput = z.object({ userId: z.string().min(1), role: z.enum(ROLES) });
const setActiveInput = z.object({ userId: z.string().min(1), active: z.boolean() });

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Active owners other than `exceptUserId`, read under a row lock so two concurrent demotions cannot both pass. */
async function otherActiveOwners(tx: Tx, exceptUserId: string): Promise<number> {
  const rows = await tx
    .select({ id: staffProfile.userId })
    .from(staffProfile)
    .where(
      and(
        eq(staffProfile.role, 'owner'),
        eq(staffProfile.active, true),
        ne(staffProfile.userId, exceptUserId),
      ),
    )
    .for('update');
  return rows.length;
}

async function lockTarget(tx: Tx, userId: string) {
  const [row] = await tx
    .select({
      userId: staffProfile.userId,
      role: staffProfile.role,
      active: staffProfile.active,
      email: user.email,
    })
    .from(staffProfile)
    .innerJoin(user, eq(user.id, staffProfile.userId))
    .where(eq(staffProfile.userId, userId))
    .for('update', { of: staffProfile });
  if (!row) throw new AppError('NOT_FOUND', 'staff member not found');
  return row;
}

/**
 * Change a staff member's role. Owner only. You cannot change your own role, and the last active owner
 * can never be demoted (the admin would be left with nobody who can manage staff or settings).
 */
export async function changeStaffRole(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof changeRoleInput>,
): Promise<{ userId: string; role: Role }> {
  assertCan(actor, 'staff.manage');
  const input = changeRoleInput.parse(rawInput);
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, input.userId);
    if (target.userId === actor.userId) {
      throw new AppError('FORBIDDEN', 'You cannot change your own role.');
    }
    if (target.role === input.role) {
      throw new AppError('VALIDATION_FAILED', `${target.email} is already ${input.role}.`);
    }
    if (
      target.role === 'owner' &&
      target.active &&
      (await otherActiveOwners(tx, target.userId)) === 0
    ) {
      throw new AppError('FORBIDDEN', 'The last active owner cannot be demoted.');
    }
    await tx
      .update(staffProfile)
      .set({ role: input.role })
      .where(eq(staffProfile.userId, target.userId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'staff.change_role',
      entity: 'staff',
      entityId: target.userId,
      before: { email: target.email, role: target.role },
      after: { email: target.email, role: input.role },
    });
    return { userId: target.userId, role: input.role };
  });
}

/**
 * Deactivate or reactivate a staff member. Owner only. You cannot deactivate yourself and the last active
 * owner cannot be deactivated. Deactivation also ends the person's sessions; access is cut at once because
 * every request re-reads the active flag.
 */
export async function setStaffActive(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof setActiveInput>,
): Promise<{ userId: string; active: boolean }> {
  assertCan(actor, 'staff.manage');
  const input = setActiveInput.parse(rawInput);
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, input.userId);
    if (!input.active) {
      if (target.userId === actor.userId) {
        throw new AppError('FORBIDDEN', 'You cannot deactivate your own account.');
      }
      if (
        target.role === 'owner' &&
        target.active &&
        (await otherActiveOwners(tx, target.userId)) === 0
      ) {
        throw new AppError('FORBIDDEN', 'The last active owner cannot be deactivated.');
      }
    }
    if (target.active === input.active) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${target.email} is already ${input.active ? 'active' : 'deactivated'}.`,
      );
    }
    await tx
      .update(staffProfile)
      .set({ active: input.active })
      .where(eq(staffProfile.userId, target.userId));
    if (!input.active) await tx.delete(session).where(eq(session.userId, target.userId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: input.active ? 'staff.reactivate' : 'staff.deactivate',
      entity: 'staff',
      entityId: target.userId,
      before: { email: target.email, active: target.active },
      after: { email: target.email, active: input.active },
    });
    return { userId: target.userId, active: input.active };
  });
}

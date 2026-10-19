import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { account, user } from '@/db/auth-schema';
import { AppError } from '@/lib/errors';
import { recordAudit, type AuditActor } from '@/modules/audit';
import { staffProfile } from './schema';
import { can, requiresTwoFactor, type Permission, ROLES, type Role } from './domain/roles';

export type StaffContext = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  twoFactorEnabled: boolean;
};

/** Look up an active staff member by user id. Returns null for customers and deactivated staff. */
export async function loadStaff(db: Db, userId: string): Promise<StaffContext | null> {
  const [row] = await db
    .select({
      userId: user.id,
      email: user.email,
      name: user.name,
      twoFactorEnabled: user.twoFactorEnabled,
      role: staffProfile.role,
    })
    .from(staffProfile)
    .innerJoin(user, eq(user.id, staffProfile.userId))
    .where(and(eq(staffProfile.userId, userId), eq(staffProfile.active, true)))
    .limit(1);
  if (!row) return null;
  return { ...row, twoFactorEnabled: row.twoFactorEnabled === true };
}

/**
 * Server-side authorization for admin actions (brief §9: hidden buttons are not security).
 * Throws UNAUTHENTICATED / FORBIDDEN / TWO_FACTOR_REQUIRED.
 */
export function assertCan(staff: StaffContext | null, permission: Permission): StaffContext {
  if (!staff) throw new AppError('UNAUTHENTICATED');
  if (requiresTwoFactor(staff.role) && !staff.twoFactorEnabled) {
    throw new AppError('TWO_FACTOR_REQUIRED');
  }
  if (!can(staff.role, permission)) throw new AppError('FORBIDDEN');
  return staff;
}

const createStaffInput = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(120),
  role: z.enum(ROLES),
  password: z.string().min(10).max(128),
});
export type CreateStaffInput = z.input<typeof createStaffInput>;

/**
 * Create a staff account. Only an Owner may call this (checked here, not by the caller), and the
 * action is audited in the same transaction. Staff are never created by public sign-up.
 * Email is marked verified because the Owner vouches for it.
 */
export async function createStaff(
  db: Db,
  actor: StaffContext,
  actorMeta: Pick<AuditActor, 'ip' | 'userAgent'>,
  rawInput: CreateStaffInput,
): Promise<{ userId: string }> {
  assertCan(actor, 'staff.manage');
  const input = createStaffInput.parse(rawInput);
  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();

  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: user.id }).from(user).where(eq(user.email, input.email));
    if (existing.length) throw new AppError('VALIDATION_FAILED', 'email already in use');
    await insertStaffRows(tx, { userId, passwordHash, ...input });
    await recordAudit(tx, {
      actor: { userId: actor.userId, role: actor.role, ...actorMeta },
      action: 'staff.create',
      entity: 'staff',
      entityId: userId,
      after: { email: input.email, role: input.role },
    });
  });
  return { userId };
}

/**
 * Bootstrap the very first Owner from the CLI (`npm run staff:create-owner`). Refuses to run if an
 * Owner already exists, so it cannot be used as a back door.
 */
export async function bootstrapOwner(
  db: Db,
  rawInput: Omit<CreateStaffInput, 'role'>,
): Promise<{ userId: string }> {
  const input = createStaffInput.omit({ role: true }).parse(rawInput);
  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  await db.transaction(async (tx) => {
    const owners = await tx
      .select({ id: staffProfile.userId })
      .from(staffProfile)
      .where(eq(staffProfile.role, 'owner'))
      .limit(1);
    if (owners.length) throw new AppError('FORBIDDEN', 'an owner already exists');
    await insertStaffRows(tx, { userId, passwordHash, role: 'owner', ...input });
    await recordAudit(tx, {
      actor: { userId, role: 'owner' },
      action: 'staff.bootstrap_owner',
      entity: 'staff',
      entityId: userId,
      after: { email: input.email },
    });
  });
  return { userId };
}

type StaffRow = { userId: string; passwordHash: string; email: string; name: string; role: Role };

async function insertStaffRows(tx: Parameters<Parameters<Db['transaction']>[0]>[0], row: StaffRow) {
  await tx.insert(user).values({
    id: row.userId,
    email: row.email,
    name: row.name,
    emailVerified: true,
  });
  await tx.insert(account).values({
    id: randomUUID(),
    accountId: row.userId,
    providerId: 'credential',
    userId: row.userId,
    password: row.passwordHash,
  });
  await tx.insert(staffProfile).values({ userId: row.userId, role: row.role });
}

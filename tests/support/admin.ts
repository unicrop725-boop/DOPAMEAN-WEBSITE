import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { auditEvent } from '../../src/db/schema';
import type { Db } from '../../src/db/client';
import type { ObjectStorage } from '../../src/modules/catalog';
import { type AdminActor, type Role } from '../../src/modules/staff';
import type { TestDb } from './test-db';

/** An admin actor as the request layer would build it (the staff row itself is not needed for most tests). */
export function actorOf(role: Role, over: Partial<AdminActor> = {}): AdminActor {
  return {
    userId: `${role}-${randomUUID().slice(0, 8)}`,
    email: `${role}@example.test`,
    name: `Test ${role}`,
    role,
    twoFactorEnabled: true,
    ip: '203.0.113.9',
    userAgent: 'vitest-admin',
    ...over,
  };
}

export const owner = () => actorOf('owner');
export const manager = () => actorOf('manager');
export const support = () => actorOf('support');
/** Owner/manager without TOTP enrolled: every admin function must refuse them. */
export const owner2faOff = () => actorOf('owner', { twoFactorEnabled: false });
export const manager2faOff = () => actorOf('manager', { twoFactorEnabled: false });

export async function auditCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(auditEvent);
  return row?.n ?? 0;
}

export async function auditRows(db: Db, entityId: string) {
  const { eq } = await import('drizzle-orm');
  return db.select().from(auditEvent).where(eq(auditEvent.entityId, entityId));
}

/** In-memory object storage for upload tests. */
export function memoryStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  let failPut = false;
  const storage: ObjectStorage = {
    async put(key, body, contentType) {
      if (failPut) throw new Error('storage unavailable');
      objects.set(key, { body, contentType });
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  return { storage, objects, setFailPut: (v: boolean) => (failPut = v) };
}

/** A real, valid PNG of the given size (so sharp can decode it). */
export async function pngBytes(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

export async function jpegBytes(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 200, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

/**
 * Make the audit insert for one action fail (a BEFORE INSERT trigger that raises). Used to prove that when
 * the audit write fails, the business change in the same transaction is rolled back.
 */
export async function breakAuditFor(t: TestDb, action: string): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const fn = `fail_audit_${suffix}`;
  await t.pool.query(`
    CREATE FUNCTION ${fn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = '${action}' THEN RAISE EXCEPTION 'audit write failed on purpose'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER ${fn} BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION ${fn}();
  `);
  return async () => {
    await t.pool.query(`DROP TRIGGER ${fn} ON audit_event; DROP FUNCTION ${fn}();`);
  };
}

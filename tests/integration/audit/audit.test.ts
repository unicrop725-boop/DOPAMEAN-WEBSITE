import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent } from '@/db/schema';
import { listAudit, recordAudit } from '@/modules/audit';
import { expectDbError, newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const actor = { userId: 'u1', role: 'manager' as const, ip: '203.0.113.9', userAgent: 'vitest' };

describe('audit log storage guarantees (INV-14)', () => {
  it('stores who, what, before/after, when and ip', async () => {
    await recordAudit(t.db, {
      actor,
      action: 'product.update',
      entity: 'product',
      entityId: 'p1',
      before: { price: 100 },
      after: { price: 120 },
    });
    const [row] = await listAudit(t.db, { entity: 'product', entityId: 'p1' });
    expect(row).toMatchObject({
      actorUserId: 'u1',
      actorRole: 'manager',
      action: 'product.update',
      before: { price: 100 },
      after: { price: 120 },
      ip: '203.0.113.9',
    });
    expect(row?.at).toBeInstanceOf(Date);
  });

  it('commits or rolls back together with the change it records', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await recordAudit(tx, { actor, action: 'rollback', entity: 'e', entityId: 'r1' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await listAudit(t.db, { entity: 'e', entityId: 'r1' })).toHaveLength(0);
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
    await recordAudit(t.db, { actor, action: 'a', entity: 'e', entityId: 'keep' });
    await expectDbError(t.db.update(auditEvent).set({ action: 'tampered' }), /append-only/);
    await expectDbError(t.db.delete(auditEvent), /append-only/);
    await expectDbError(t.db.execute(sql`TRUNCATE audit_event`), /append-only/);
    expect(await listAudit(t.db, { entity: 'e', entityId: 'keep' })).toHaveLength(1);
  });
});

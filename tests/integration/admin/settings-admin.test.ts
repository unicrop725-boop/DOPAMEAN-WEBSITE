import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent, storeSetting, taxRule } from '@/db/schema';
import {
  createTaxRuleAdmin,
  paymentProviderStatus,
  updateSettingsAdmin,
} from '@/lib/admin/settings';
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings';
import { listTaxRules } from '@/modules/tax';
import { newTestDb, type TestDb } from '../../support/test-db';
import {
  auditCount,
  breakAuditFor,
  manager,
  owner,
  owner2faOff,
  support,
} from '../../support/admin';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const settingsAudits = () =>
  t.db.select().from(auditEvent).where(eq(auditEvent.entity, 'settings'));

describe('updateSettingsAdmin', () => {
  it('saves the change and audits the full before and after values with ip and actor', async () => {
    const actor = owner();
    const res = await updateSettingsAdmin(t.db, actor, {
      storeName: 'DOPAMEAN Test',
      shippingFlatPaise: 7_900,
      freeShippingThresholdPaise: 199_900,
      codMaxPaise: 300_000,
      codFeePaise: 4_900,
      gstin: '06ABCDE1234F1Z5',
      contactEmail: 'owner@example.test',
    });
    expect(res.changed.sort()).toEqual(
      [
        'codFeePaise',
        'codMaxPaise',
        'contactEmail',
        'freeShippingThresholdPaise',
        'gstin',
        'shippingFlatPaise',
        'storeName',
      ].sort(),
    );
    expect(await getSettings(t.db)).toMatchObject({
      storeName: 'DOPAMEAN Test',
      shippingFlatPaise: 7_900,
      freeShippingThresholdPaise: 199_900,
      codFeePaise: 4_900,
      gstin: '06ABCDE1234F1Z5',
    });
    const [a] = await settingsAudits();
    expect(a).toMatchObject({
      actorUserId: actor.userId,
      actorRole: 'owner',
      action: 'settings.update',
      entityId: 'store',
      ip: '203.0.113.9',
      userAgent: 'vitest-admin',
    });
    expect(a!.before).toMatchObject({
      storeName: DEFAULT_SETTINGS.storeName,
      shippingFlatPaise: 9_900,
    });
    expect(a!.after).toMatchObject({ storeName: 'DOPAMEAN Test', shippingFlatPaise: 7_900 });
  });

  it('a save that changes nothing writes no audit event', async () => {
    const before = await auditCount(t.db);
    const res = await updateSettingsAdmin(t.db, owner(), { storeName: 'DOPAMEAN Test' });
    expect(res.changed).toEqual([]);
    expect(await auditCount(t.db)).toBe(before);
  });

  it('threshold 0 means shipping is always free and can be set explicitly', async () => {
    await updateSettingsAdmin(t.db, owner(), { freeShippingThresholdPaise: 0 });
    expect((await getSettings(t.db)).freeShippingThresholdPaise).toBe(0);
  });

  it.each([
    ['negative shipping', { shippingFlatPaise: -1 }, 'shippingFlatPaise'],
    ['fractional paise', { shippingFlatPaise: 99.5 }, 'shippingFlatPaise'],
    ['bad GSTIN', { gstin: 'not-a-gstin' }, 'gstin'],
    ['bad state code', { sellerStateCode: '6' }, 'sellerStateCode'],
    ['bad email', { contactEmail: 'nope' }, 'contactEmail'],
    ['empty store name', { storeName: '  ' }, 'storeName'],
    ['absurd COD fee', { codFeePaise: 999_999_999 }, 'codFeePaise'],
  ])('rejects %s with a field error and changes nothing', async (_n, patch, field) => {
    const before = await getSettings(t.db);
    const n = await auditCount(t.db);
    const err = await updateSettingsAdmin(t.db, owner(), patch).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(Object.keys(err.details.fieldErrors)).toContain(field);
    expect(await getSettings(t.db)).toEqual(before);
    expect(await auditCount(t.db)).toBe(n);
  });

  it('only an owner: manager and support are FORBIDDEN, an owner without 2FA is refused', async () => {
    const before = await getSettings(t.db);
    const n = await auditCount(t.db);
    await expect(
      updateSettingsAdmin(t.db, manager(), { storeName: 'Hacked' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      updateSettingsAdmin(t.db, support(), { storeName: 'Hacked' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      updateSettingsAdmin(t.db, owner2faOff(), { storeName: 'Hacked' }),
    ).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    expect(await getSettings(t.db)).toEqual(before);
    expect(await auditCount(t.db)).toBe(n);
  });

  it('rolls the settings back when the audit write fails', async () => {
    const before = await getSettings(t.db);
    const restore = await breakAuditFor(t, 'settings.update');
    try {
      await expect(
        updateSettingsAdmin(t.db, owner(), { storeName: 'Rolled Back' }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await getSettings(t.db)).toEqual(before);
    const [row] = await t.db.select().from(storeSetting).where(eq(storeSetting.key, 'store'));
    expect((row!.value as { storeName: string }).storeName).toBe('DOPAMEAN Test');
  });
});

describe('createTaxRuleAdmin', () => {
  it('creates fixed and slab rules, audited', async () => {
    const fixed = await createTaxRuleAdmin(t.db, owner(), {
      name: 'Flat 12%',
      kind: 'fixed',
      rateBp: 1200,
    });
    const slab = await createTaxRuleAdmin(t.db, owner(), {
      name: 'Slab',
      kind: 'slab',
      rateBp: 500,
      slabThresholdPaise: 100_000,
      rateBpAbove: 1200,
    });
    const rules = await listTaxRules(t.db);
    expect(rules.find((r) => r.id === fixed.taxRuleId)).toMatchObject({
      kind: 'fixed',
      rateBp: 1200,
    });
    expect(rules.find((r) => r.id === slab.taxRuleId)).toMatchObject({
      kind: 'slab',
      slabThresholdPaise: 100_000,
      rateBpAbove: 1200,
    });
    const a = (
      await t.db.select().from(auditEvent).where(eq(auditEvent.entityId, slab.taxRuleId))
    )[0];
    expect(a).toMatchObject({ action: 'tax_rule.create', ip: '203.0.113.9' });
  });

  it.each([
    ['rate above 100%', { name: 'Bad', kind: 'fixed' as const, rateBp: 10_001 }, 'rateBp'],
    ['negative rate', { name: 'Bad', kind: 'fixed' as const, rateBp: -1 }, 'rateBp'],
    [
      'slab without threshold',
      { name: 'Bad', kind: 'slab' as const, rateBp: 500, rateBpAbove: 1200 },
      'slabThresholdPaise',
    ],
    [
      'slab without upper rate',
      { name: 'Bad', kind: 'slab' as const, rateBp: 500, slabThresholdPaise: 5000 },
      'rateBpAbove',
    ],
    ['short name', { name: 'x', kind: 'fixed' as const, rateBp: 500 }, 'name'],
  ])('rejects %s', async (_n, input, field) => {
    const before = (await listTaxRules(t.db)).length;
    const err = await createTaxRuleAdmin(t.db, owner(), input).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(Object.keys(err.details.fieldErrors)).toContain(field);
    expect((await listTaxRules(t.db)).length).toBe(before);
  });

  it('only an owner; rolls back when the audit write fails', async () => {
    const n = (await listTaxRules(t.db)).length;
    await expect(
      createTaxRuleAdmin(t.db, manager(), { name: 'Sneaky', kind: 'fixed', rateBp: 100 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createTaxRuleAdmin(t.db, owner2faOff(), { name: 'Sneaky', kind: 'fixed', rateBp: 100 }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    const restore = await breakAuditFor(t, 'tax_rule.create');
    try {
      await expect(
        createTaxRuleAdmin(t.db, owner(), { name: 'Rolled back', kind: 'fixed', rateBp: 100 }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await listTaxRules(t.db)).length).toBe(n);
    expect(await t.db.select().from(taxRule).where(eq(taxRule.name, 'Rolled back'))).toHaveLength(
      0,
    );
  });
});

describe('paymentProviderStatus', () => {
  it('reports configured / not configured and mode without exposing any secret', () => {
    expect(paymentProviderStatus({})).toEqual({
      configured: false,
      webhookConfigured: false,
      mode: null,
    });
    const s = paymentProviderStatus({
      RAZORPAY_KEY_ID: 'rzp_test_abc123',
      RAZORPAY_KEY_SECRET: 'super-secret-value',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_value',
    });
    expect(s).toEqual({ configured: true, webhookConfigured: true, mode: 'test' });
    expect(JSON.stringify(s)).not.toContain('super-secret');
    expect(JSON.stringify(s)).not.toContain('abc123');
    expect(
      paymentProviderStatus({ RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's' }).mode,
    ).toBe('live');
    expect(paymentProviderStatus({ RAZORPAY_KEY_ID: 'rzp_test_x' }).configured).toBe(false);
    expect(
      paymentProviderStatus({ RAZORPAY_KEY_ID: '  ', RAZORPAY_KEY_SECRET: ' ' }).configured,
    ).toBe(false);
  });
});

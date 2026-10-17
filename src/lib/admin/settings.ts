import { z } from 'zod';
import type { Db } from '@/db/client';
import { AppError } from '@/lib/errors';
import {
  getSettings,
  storeSettingsSchema,
  updateSettings,
  type StoreSettings,
} from '@/lib/settings';
import { recordAudit } from '@/modules/audit';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';
import { createTaxRule } from '@/modules/tax';

function validationError(error: z.ZodError): AppError {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return new AppError('VALIDATION_FAILED', Object.values(fieldErrors)[0] ?? 'Invalid input', {
    fieldErrors,
  });
}

/**
 * Update store settings (permission settings.manage, owner only). The change and its audit event, with the
 * values before and after, commit together. Returns the list of keys that actually changed.
 */
export async function updateSettingsAdmin(
  db: Db,
  actor: AdminActor,
  patch: Partial<StoreSettings>,
): Promise<{ changed: string[] }> {
  assertCan(actor, 'settings.manage');
  const current = await getSettings(db);
  const check = storeSettingsSchema.safeParse({ ...current, ...patch });
  if (!check.success) throw validationError(check.error);
  return db.transaction(async (tx) => {
    const { before, after } = await updateSettings(tx, patch, actor.userId);
    const keys = Object.keys(after) as (keyof StoreSettings)[];
    const changed = keys.filter((k) => before[k] !== after[k]);
    if (changed.length === 0) return { changed: [] };
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'settings.update',
      entity: 'settings',
      entityId: 'store',
      before,
      after,
    });
    return { changed: changed as string[] };
  });
}

const taxRuleInput = z
  .object({
    name: z.string().trim().min(2, 'Enter a name').max(80),
    kind: z.enum(['fixed', 'slab']),
    rateBp: z
      .number()
      .int()
      .min(0, 'Rate cannot be negative')
      .max(10_000, 'Rate cannot exceed 100%'),
    slabThresholdPaise: z.number().int().min(1).max(100_000_000).optional(),
    rateBpAbove: z.number().int().min(0).max(10_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'slab') {
      if (v.slabThresholdPaise === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['slabThresholdPaise'],
          message: 'Enter the price threshold',
        });
      }
      if (v.rateBpAbove === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['rateBpAbove'],
          message: 'Enter the rate above the threshold',
        });
      }
    }
  });
export type TaxRuleAdminInput = z.input<typeof taxRuleInput>;

/** Add a GST rule (permission settings.manage). Rules are never edited in place: past orders keep their snapshot. */
export async function createTaxRuleAdmin(
  db: Db,
  actor: AdminActor,
  rawInput: TaxRuleAdminInput,
): Promise<{ taxRuleId: string }> {
  assertCan(actor, 'settings.manage');
  const parsed = taxRuleInput.safeParse(rawInput);
  if (!parsed.success) throw validationError(parsed.error);
  const input = parsed.data;
  return db.transaction(async (tx) => {
    const id = await createTaxRule(tx, {
      name: input.name,
      kind: input.kind,
      rateBp: input.rateBp,
      ...(input.kind === 'slab'
        ? { slabThresholdPaise: input.slabThresholdPaise, rateBpAbove: input.rateBpAbove }
        : {}),
    });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'tax_rule.create',
      entity: 'tax_rule',
      entityId: id,
      after: input,
    });
    return { taxRuleId: id };
  });
}

export type PaymentProviderStatus = {
  configured: boolean;
  webhookConfigured: boolean;
  /** Test keys start with rzp_test_. Only the mode is exposed, never the key. */
  mode: 'test' | 'live' | null;
};

/** Whether online payments are set up, derived from the environment. Never returns a secret. */
export function paymentProviderStatus(
  env: Record<string, string | undefined> = process.env,
): PaymentProviderStatus {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const configured = Boolean(keyId && env.RAZORPAY_KEY_SECRET?.trim());
  return {
    configured,
    webhookConfigured: Boolean(env.RAZORPAY_WEBHOOK_SECRET?.trim()),
    mode: configured ? (keyId!.startsWith('rzp_live_') ? 'live' : 'test') : null,
  };
}

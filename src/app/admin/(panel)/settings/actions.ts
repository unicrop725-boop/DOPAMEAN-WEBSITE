'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { renameFieldErrors, runAction, type ActionState } from '@/lib/action-result';
import { noticeHref } from '@/lib/admin/notices';
import { createTaxRuleAdmin, updateSettingsAdmin } from '@/lib/admin/settings';
import { AppError } from '@/lib/errors';
import { parseRupees } from '@/lib/rupees';
import { resolveStaffFor } from '@/lib/staff-context';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

function paise(form: FormData, key: string, label: string): number {
  const v = parseRupees(text(form, key));
  if (v === null) {
    const message = `${label}: enter an amount in rupees, for example 99 or 99.50`;
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: { [key]: message } });
  }
  return v;
}

export async function saveSettingsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('settings.manage');
    await updateSettingsAdmin(getDb(), admin, {
      storeName: text(form, 'storeName'),
      contactEmail: text(form, 'contactEmail') || null,
      gstin: text(form, 'gstin') || null,
      sellerStateCode: text(form, 'sellerStateCode'),
      shippingFlatPaise: paise(form, 'shippingFlat', 'Flat shipping rate'),
      freeShippingThresholdPaise: paise(form, 'freeShippingThreshold', 'Free-shipping threshold'),
      codEnabled: form.get('codEnabled') === 'on',
      codMaxPaise: paise(form, 'codMax', 'COD maximum order value'),
      codFeePaise: paise(form, 'codFee', 'COD fee'),
    });
  }, form);
  if (!result.ok) {
    return renameFieldErrors(result, {
      shippingFlatPaise: 'shippingFlat',
      freeShippingThresholdPaise: 'freeShippingThreshold',
      codMaxPaise: 'codMax',
      codFeePaise: 'codFee',
    });
  }
  revalidatePath('/admin/settings');
  redirect(noticeHref('/admin/settings', 'settings-saved'));
}

export async function createTaxRuleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('settings.manage');
    const kind = text(form, 'kind') === 'slab' ? 'slab' : 'fixed';
    const bp = (key: string, label: string): number | undefined => {
      const raw = text(form, key);
      if (!raw) return undefined;
      // Percent text such as "5" or "12.5" to basis points without floats.
      const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
      if (!m) {
        const message = `${label}: enter a percentage such as 5 or 12.5`;
        throw new AppError('VALIDATION_FAILED', message, { fieldErrors: { [key]: message } });
      }
      return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
    };
    const rate = bp('rate', 'Rate');
    if (rate === undefined) {
      const message = 'Rate: enter a percentage such as 5 or 12.5';
      throw new AppError('VALIDATION_FAILED', message, { fieldErrors: { rate: message } });
    }
    const threshold = text(form, 'slabThreshold');
    await createTaxRuleAdmin(getDb(), admin, {
      name: text(form, 'name'),
      kind,
      rateBp: rate,
      ...(kind === 'slab'
        ? {
            slabThresholdPaise: threshold
              ? paise(form, 'slabThreshold', 'Price threshold')
              : undefined,
            rateBpAbove: bp('rateAbove', 'Rate above the threshold'),
          }
        : {}),
    });
  }, form);
  if (!result.ok) {
    return renameFieldErrors(result, {
      rateBp: 'rate',
      slabThresholdPaise: 'slabThreshold',
      rateBpAbove: 'rateAbove',
    });
  }
  revalidatePath('/admin/settings');
  redirect(noticeHref('/admin/settings', 'tax-rule-created'));
}

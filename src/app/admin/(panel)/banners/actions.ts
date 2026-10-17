'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { runAction, type ActionState } from '@/lib/action-result';
import {
  clearFaviconAdmin,
  deleteBannerAdmin,
  moveBannerAdmin,
  updateBannerAdmin,
} from '@/lib/admin/banners';
import { resolveStaffFor } from '@/lib/staff-context';
import { s3StorageFromEnv } from '@/modules/catalog';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export async function updateBannerAction(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await updateBannerAdmin(getDb(), admin, id, {
      alt: text(form, 'alt'),
      linkUrl: text(form, 'linkUrl'),
      active: form.get('active') === 'on',
      ...(form.has('heading') ? { heading: text(form, 'heading') } : {}),
      ...(form.has('body') ? { body: text(form, 'body') } : {}),
      ...(form.has('ctaLabel') ? { ctaLabel: text(form, 'ctaLabel') } : {}),
    });
    return 'Banner saved.';
  }, form);
  if (result.ok) revalidatePath('/admin/banners');
  return result;
}

export async function moveBannerAction(
  id: string,
  direction: 'up' | 'down',
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await moveBannerAdmin(getDb(), admin, id, direction);
    return 'Banner moved.';
  });
  if (result.ok) revalidatePath('/admin/banners');
  return result;
}

export async function deleteBannerAction(
  id: string,
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await deleteBannerAdmin(getDb(), admin, s3StorageFromEnv(), id);
    return 'Banner deleted.';
  });
  if (result.ok) revalidatePath('/admin/banners');
  return result;
}

export async function clearFaviconAction(
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('settings.manage');
    await clearFaviconAdmin(getDb(), admin, s3StorageFromEnv());
    return 'Back to the built-in site icon.';
  });
  if (result.ok) revalidatePath('/admin/banners');
  return result;
}

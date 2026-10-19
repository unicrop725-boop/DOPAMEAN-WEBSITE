'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { getDb } from '@/db/client';
import { getAuth } from '@/lib/auth';
import { verifyUserPassword } from '@/lib/auth-password';
import { AppError } from '@/lib/errors';
import { requireUser } from '@/lib/session';
import {
  anonymizeCustomer,
  createAddress,
  deleteAddress,
  setDefaultAddress,
  updateAddress,
} from '@/modules/customers';
import { loadStaff } from '@/modules/staff';

export type FormState = { ok: boolean; message?: string; fieldErrors?: Record<string, string> };

function readAddress(form: FormData) {
  const text = (k: string) => String(form.get(k) ?? '');
  return {
    fullName: text('fullName'),
    line1: text('line1'),
    line2: text('line2'),
    city: text('city'),
    stateCode: text('stateCode'),
    pincode: text('pincode'),
    phone: text('phone'),
    isDefault: form.get('isDefault') === 'on',
  };
}

function toFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export async function saveAddressAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser('/account/addresses');
  const id = String(form.get('id') ?? '');
  try {
    const input = readAddress(form);
    if (id) await updateAddress(getDb(), user.id, id, input);
    else await createAddress(getDb(), user.id, input);
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, fieldErrors: toFieldErrors(err) };
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
  revalidatePath('/account/addresses');
  redirect('/account/addresses');
}

export async function deleteAddressAction(form: FormData): Promise<void> {
  const user = await requireUser('/account/addresses');
  try {
    await deleteAddress(getDb(), user.id, String(form.get('id') ?? ''));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  revalidatePath('/account/addresses');
}

export async function setDefaultAddressAction(form: FormData): Promise<void> {
  const user = await requireUser('/account/addresses');
  try {
    await setDefaultAddress(getDb(), user.id, String(form.get('id') ?? ''));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  revalidatePath('/account/addresses');
}

export async function deleteAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser('/account/privacy');
  if (await loadStaff(getDb(), user.id)) {
    return { ok: false, message: 'Staff accounts must be removed by an Owner.' };
  }
  if (form.get('confirm') !== 'DELETE') {
    return { ok: false, message: 'Type DELETE to confirm.' };
  }
  if (!(await verifyUserPassword(user.id, String(form.get('password') ?? '')))) {
    return { ok: false, message: 'That password is not correct.' };
  }
  await anonymizeCustomer(getDb(), user.id);
  await getAuth().api.signOut({ headers: await headers() });
  redirect('/?account-deleted=1');
}

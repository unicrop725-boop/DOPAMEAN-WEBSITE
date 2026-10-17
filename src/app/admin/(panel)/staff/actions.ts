'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { runAction, type ActionState } from '@/lib/action-result';
import { noticeHref } from '@/lib/admin/notices';
import { resolveStaffFor } from '@/lib/staff-context';
import { changeStaffRole, createStaff, setStaffActive, type Role } from '@/modules/staff';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export async function createStaffAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('staff.manage');
    await createStaff(getDb(), admin, admin, {
      email: text(form, 'email'),
      name: text(form, 'name'),
      role: text(form, 'role') as Role,
      password: String(form.get('password') ?? ''),
    });
  }, form);
  if (!result.ok) return result;
  revalidatePath('/admin/staff');
  redirect(noticeHref('/admin/staff', 'staff-created'));
}

export async function changeRoleAction(
  userId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('staff.manage');
    const r = await changeStaffRole(getDb(), admin, { userId, role: text(form, 'role') as Role });
    return `Role changed to ${r.role}.`;
  }, form);
  if (result.ok) revalidatePath('/admin/staff');
  return result;
}

export async function setActiveAction(userId: string, active: boolean): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('staff.manage');
    await setStaffActive(getDb(), admin, { userId, active });
    return active ? 'Account reactivated.' : 'Account deactivated. Their sessions were ended.';
  });
  if (result.ok) revalidatePath('/admin/staff');
  return result;
}

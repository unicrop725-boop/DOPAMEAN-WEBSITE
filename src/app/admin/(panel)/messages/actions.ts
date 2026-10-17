'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { runAction, type ActionState } from '@/lib/action-result';
import { setContactMessageHandled } from '@/lib/admin/messages';
import { resolveStaffFor } from '@/lib/staff-context';

export async function setHandledAction(messageId: string, handled: boolean): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('customers.view');
    await setContactMessageHandled(getDb(), admin, messageId, handled);
    return handled ? 'Message marked as handled.' : 'Message reopened.';
  });
  if (result.ok) revalidatePath('/admin/messages');
  return result;
}

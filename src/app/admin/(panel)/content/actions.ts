'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { runAction, type ActionState } from '@/lib/action-result';
import { saveContentPageAdmin } from '@/lib/admin/content';
import { noticeHref } from '@/lib/admin/notices';
import { resolveStaffFor } from '@/lib/staff-context';

export async function saveContentAction(
  slug: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await saveContentPageAdmin(getDb(), admin, slug, {
      title: String(form.get('title') ?? '').trim(),
      body: String(form.get('body') ?? '').replace(/\r\n/g, '\n'),
      published: form.get('published') === 'on',
    });
  }, form);
  if (!result.ok) return result;
  revalidatePath('/admin/content');
  revalidatePath(`/pages/${slug}`);
  redirect(noticeHref(`/admin/content/${slug}`, 'content-saved'));
}

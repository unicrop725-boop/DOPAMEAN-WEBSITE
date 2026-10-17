'use server';

import { headers } from 'next/headers';
import { ZodError } from 'zod';
import { getDb } from '@/db/client';
import { contactInput, saveContactMessage } from '@/lib/content';
import { hitRateLimit } from '@/lib/rate-limit';

export type ContactState = {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string>;
  /** What the visitor typed, so the form can show it again (React resets forms after an action). */
  values?: Record<string, string>;
};

function clientIp(h: Headers): string | null {
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || h.get('x-real-ip') || null;
}

export async function sendContactAction(prev: ContactState, form: FormData): Promise<ContactState> {
  const result = await sendContact(prev, form);
  if (result.ok) return result;
  const values: Record<string, string> = {};
  for (const k of ['name', 'email', 'subject', 'message']) values[k] = String(form.get(k) ?? '');
  return { ...result, values };
}

async function sendContact(_prev: ContactState, form: FormData): Promise<ContactState> {
  // Honeypot: real visitors never see or fill this field. Pretend success so bots learn nothing.
  if (String(form.get('website') ?? '') !== '') return { ok: true };

  const h = await headers();
  const ip = clientIp(h);
  const db = getDb();
  const limit = await hitRateLimit(db, `contact:${ip ?? 'unknown'}`, 5, 60 * 60);
  if (!limit.allowed) {
    return { ok: false, message: 'Too many messages. Please try again later.' };
  }

  try {
    const input = contactInput.parse({
      name: form.get('name'),
      email: form.get('email'),
      subject: String(form.get('subject') ?? ''),
      message: form.get('message'),
    });
    await db.transaction((tx) =>
      saveContactMessage(tx, input, ip, process.env.CONTACT_INBOX || undefined),
    );
    return { ok: true, message: 'Thank you. Your message has been sent.' };
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
      return { ok: false, fieldErrors };
    }
    throw err;
  }
}

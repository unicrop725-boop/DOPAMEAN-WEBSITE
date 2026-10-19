import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { contactMessage, contentPage } from '@/db/platform-schema';
import { z } from 'zod';
import { enqueueEmail } from '@/modules/notifications';
import { DEFAULT_CONTENT_PAGES } from '@/lib/content-defaults';

export async function getContentPage(db: DbOrTx, slug: string) {
  const [row] = await db
    .select()
    .from(contentPage)
    .where(and(eq(contentPage.slug, slug), eq(contentPage.published, true)))
    .limit(1);
  return row ?? null;
}

export async function upsertContentPage(
  db: DbOrTx,
  page: { slug: string; title: string; body: string; published?: boolean },
): Promise<void> {
  await db
    .insert(contentPage)
    .values({ ...page, published: page.published ?? true })
    .onConflictDoUpdate({
      target: contentPage.slug,
      set: { title: page.title, body: page.body, published: page.published ?? true },
    });
}

export const contactInput = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  message: z.string().trim().min(10, 'Write at least a few words').max(2000),
});
export type ContactInput = z.infer<typeof contactInput>;

/**
 * Store a contact-form message and, if an inbox is configured, queue an email to it through the
 * outbox in the same transaction.
 */
export async function saveContactMessage(
  db: DbOrTx,
  input: ContactInput,
  ip: string | null,
  inbox: string | undefined,
): Promise<string> {
  const [row] = await db
    .insert(contactMessage)
    .values({ ...input, ip })
    .returning({ id: contactMessage.id });
  if (!row) throw new Error('contact insert failed');
  if (inbox) {
    await enqueueEmail(db, {
      to: inbox,
      subject: `New contact message from ${input.name}`,
      text: `From: ${input.name} <${input.email}>\n\n${input.message}`,
    });
  }
  return row.id;
}

/** Insert the starter footer pages that do not exist yet. Never overwrites text the owner has edited. */
export async function ensureDefaultContentPages(db: DbOrTx): Promise<number> {
  const rows = await db
    .insert(contentPage)
    .values(DEFAULT_CONTENT_PAGES)
    .onConflictDoNothing()
    .returning({ slug: contentPage.slug });
  return rows.length;
}

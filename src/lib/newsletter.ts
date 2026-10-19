import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '@/db/client';
import { newsletterSubscriber } from '@/db/platform-schema';
import { indianMobile } from '@/modules/customers';

export const newsletterInput = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  phone: indianMobile,
});
export type NewsletterInput = z.infer<typeof newsletterInput>;

/**
 * Add (or refresh) a footer sign-up. One row per email: signing up again updates the name and phone and
 * clears a previous unsubscribe. Returns whether the address was new.
 */
export async function subscribeToNewsletter(
  db: DbOrTx,
  input: NewsletterInput,
  ip: string | null,
): Promise<{ created: boolean }> {
  const rows = await db
    .insert(newsletterSubscriber)
    .values({ ...input, ip })
    .onConflictDoUpdate({
      target: newsletterSubscriber.email,
      set: { firstName: input.firstName, phone: input.phone, unsubscribedAt: null },
    })
    // xmax is 0 only for a freshly inserted row; an ON CONFLICT update sets it.
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { created: rows[0]?.inserted === true };
}

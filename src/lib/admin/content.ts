import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '@/db/client';
import { contentPage } from '@/db/platform-schema';
import { DEFAULT_CONTENT_PAGES } from '@/lib/content-defaults';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import { assertCan, auditActorOf, type AdminActor } from '@/modules/staff';

export type AdminContentPage = {
  slug: string;
  title: string;
  body: string;
  published: boolean;
  updatedAt: Date | null;
  /** True when the page has never been saved: the storefront shows nothing for it yet. */
  isDefaultText: boolean;
};

const defaultsBySlug = new Map(DEFAULT_CONTENT_PAGES.map((p) => [p.slug, p]));

/** All editable pages: saved ones plus starter pages that have not been saved yet (permission catalog.edit). */
export async function listContentPagesAdmin(
  db: DbOrTx,
  actor: AdminActor,
): Promise<AdminContentPage[]> {
  assertCan(actor, 'catalog.edit');
  const rows = await db.select().from(contentPage).orderBy(asc(contentPage.title));
  const saved = new Map(rows.map((r) => [r.slug, r]));
  const out: AdminContentPage[] = rows.map((r) => ({ ...r, isDefaultText: false }));
  for (const d of DEFAULT_CONTENT_PAGES) {
    if (!saved.has(d.slug)) {
      out.push({ ...d, published: true, updatedAt: null, isDefaultText: true });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getContentPageAdmin(
  db: DbOrTx,
  actor: AdminActor,
  slug: string,
): Promise<AdminContentPage | null> {
  assertCan(actor, 'catalog.edit');
  const [row] = await db.select().from(contentPage).where(eq(contentPage.slug, slug)).limit(1);
  if (row) return { ...row, isDefaultText: false };
  const d = defaultsBySlug.get(slug);
  return d ? { ...d, published: true, updatedAt: null, isDefaultText: true } : null;
}

const pageInput = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(120),
  body: z.string().max(50_000, 'At most 50,000 characters'),
  published: z.boolean(),
});

/**
 * Save a footer page (permission catalog.edit). Only pages that already exist, or the starter pages, can be
 * saved: editors cannot invent new URLs. The body is plain text, so no markup can be injected.
 */
export async function saveContentPageAdmin(
  db: Db,
  actor: AdminActor,
  slug: string,
  rawInput: z.input<typeof pageInput>,
): Promise<void> {
  assertCan(actor, 'catalog.edit');
  const parsed = pageInput.safeParse(rawInput);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    throw new AppError('VALIDATION_FAILED', Object.values(fieldErrors)[0] ?? 'Invalid input', {
      fieldErrors,
    });
  }
  const input = parsed.data;
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(contentPage).where(eq(contentPage.slug, slug)).limit(1);
    if (!before && !defaultsBySlug.has(slug)) throw new AppError('NOT_FOUND', 'Page not found.');
    await tx
      .insert(contentPage)
      .values({ slug, ...input })
      .onConflictDoUpdate({ target: contentPage.slug, set: input });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: 'content.update',
      entity: 'content_page',
      entityId: slug,
      before: before
        ? { title: before.title, body: before.body, published: before.published }
        : null,
      after: input,
    });
  });
}

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { toActionError } from '@/lib/action-result';
import { setFaviconAdmin, uploadBannerAdmin } from '@/lib/admin/banners';
import { assertSameOrigin } from '@/lib/csrf';
import { AppError } from '@/lib/errors';
import { resolveStaffFor } from '@/lib/staff-context';
import { MAX_UPLOAD_BYTES, s3StorageFromEnv } from '@/modules/catalog';

export const dynamic = 'force-dynamic';

/**
 * Banner and site-icon upload. A route handler (not a server action) because actions cap bodies at 1 MB.
 * Same rules as every admin write: same-origin only, authorized on the server (banners need catalog.edit,
 * the site icon needs settings.manage), then one module function validates and re-encodes the image.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const form = await req.formData();
    const kind = String(form.get('kind') ?? 'banner');
    if (kind !== 'banner' && kind !== 'favicon') {
      throw new AppError('VALIDATION_FAILED', 'Unknown upload type.');
    }
    const { admin } = await resolveStaffFor(
      kind === 'favicon' ? 'settings.manage' : 'catalog.edit',
    );

    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > MAX_UPLOAD_BYTES + 512 * 1024) {
      throw new AppError('VALIDATION_FAILED', 'The image is larger than 5 MB.');
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new AppError('VALIDATION_FAILED', 'Choose an image file to upload.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'The image is larger than 5 MB.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const storage = s3StorageFromEnv();
    if (kind === 'favicon') {
      await setFaviconAdmin(getDb(), admin, storage, bytes);
      revalidatePath('/admin/banners');
      return Response.json({ ok: true, message: 'Site icon updated.' });
    }
    await uploadBannerAdmin(getDb(), admin, storage, {
      bytes,
      alt: String(form.get('alt') ?? ''),
      linkUrl: String(form.get('linkUrl') ?? ''),
      placement: String(form.get('placement') ?? 'collection'),
      heading: String(form.get('heading') ?? ''),
      body: String(form.get('body') ?? ''),
      ctaLabel: String(form.get('ctaLabel') ?? ''),
    });
    revalidatePath('/admin/banners');
    return Response.json({ ok: true, message: 'Banner uploaded.' });
  } catch (err) {
    const state = toActionError(err);
    const status = err instanceof AppError ? err.status : 500;
    return Response.json(state, { status });
  }
}

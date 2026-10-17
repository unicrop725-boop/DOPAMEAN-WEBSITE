import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { toActionError } from '@/lib/action-result';
import { assertSameOrigin } from '@/lib/csrf';
import { AppError } from '@/lib/errors';
import { resolveStaffFor } from '@/lib/staff-context';
import { MAX_UPLOAD_BYTES, s3StorageFromEnv, uploadProductMedia } from '@/modules/catalog';

export const dynamic = 'force-dynamic';

/**
 * Product image upload. A route handler rather than a server action because server actions cap request
 * bodies at 1 MB. Same rules as every admin write: same-origin only, authorized on the server (catalog.edit),
 * then one module function validates the bytes (size, magic bytes, no SVG, re-encode) and records the audit event.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { admin } = await resolveStaffFor('catalog.edit');

    const declared = Number(req.headers.get('content-length') ?? '0');
    // Allow for multipart overhead; the module re-checks the real file size.
    if (declared > MAX_UPLOAD_BYTES + 512 * 1024) {
      throw new AppError('VALIDATION_FAILED', 'The image is larger than 5 MB.');
    }

    const form = await req.formData();
    const file = form.get('file');
    const productId = String(form.get('productId') ?? '');
    if (!(file instanceof File) || !productId) {
      throw new AppError('VALIDATION_FAILED', 'Choose an image file to upload.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'The image is larger than 5 MB.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await uploadProductMedia(getDb(), admin, s3StorageFromEnv(), {
      productId,
      bytes,
      alt: String(form.get('alt') ?? ''),
    });
    revalidatePath(`/admin/products/${productId}`);
    return Response.json({ ok: true, message: 'Image uploaded.', mediaId: result.mediaId });
  } catch (err) {
    const state = toActionError(err);
    const status = err instanceof AppError ? err.status : 500;
    return Response.json(state, { status });
  }
}

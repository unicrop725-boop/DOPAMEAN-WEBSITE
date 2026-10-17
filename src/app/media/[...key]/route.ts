import { s3StorageFromEnv, SERVABLE_MEDIA_KEY } from '@/modules/catalog';
import { baseLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Serves uploaded images (product photos, banners, site icon) from object storage, so the bucket itself never
 * has to be public. Only keys this application created are served: a strict pattern, never a listing.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.join('/');
  if (!SERVABLE_MEDIA_KEY.test(key)) return new Response('Not found', { status: 404 });
  try {
    const object = await s3StorageFromEnv().get?.(key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(object.body), {
      headers: {
        'content-type': object.contentType,
        // Keys are random and never reused, so the content behind a key never changes.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    baseLogger.error({ err, key }, 'media read failed');
    return new Response('Unavailable', { status: 503 });
  }
}

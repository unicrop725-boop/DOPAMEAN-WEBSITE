import { randomBytes } from 'node:crypto';
import { AppError } from '@/lib/errors';
import {
  MAX_IMAGE_EDGE_PX,
  MAX_UPLOAD_BYTES,
  validateUpload,
  type ImageKind,
} from './domain/image';

export type ProcessedImage = { data: Buffer; width: number; height: number; contentType: string };

/** Pixel budget for decoding (a 5 MB file can still expand to a huge bitmap: refuse decompression bombs). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Validate, decode and re-encode an uploaded image (brief section 9): magic bytes decide the type, SVG and
 * polyglots are refused, the image is auto-rotated, resized to at most 2400 px on the long edge and written
 * as WebP, which drops EXIF/GPS/ICC metadata and anything appended to the original file.
 */
export async function processImageUpload(
  bytes: Uint8Array,
  maxBytes = MAX_UPLOAD_BYTES,
  maxEdge = MAX_IMAGE_EDGE_PX,
): Promise<ProcessedImage> {
  const verdict = validateUpload(bytes, maxBytes);
  if (!verdict.ok)
    throw new AppError('VALIDATION_FAILED', verdict.message, { reason: verdict.reason });

  const expected: Record<ImageKind, string> = { jpeg: 'jpeg', png: 'png', webp: 'webp' };
  // Loaded on demand so pages that only read the catalog do not pay for the native image library.
  const sharp = (await import('sharp')).default;
  try {
    const input = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await input.metadata();
    if (meta.format !== expected[verdict.kind]) {
      throw new Error('declared and decoded formats differ');
    }
    const { data, info } = await input
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, contentType: 'image/webp' };
  } catch {
    throw new AppError('VALIDATION_FAILED', 'That file is not a valid image.', {
      reason: 'DECODE_FAILED',
    });
  }
}

/** Where processed images go. Injected so tests can use memory and production uses S3. */
export type ObjectStorage = {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Read an object back (the app serves uploads itself, so the bucket never has to be public). */
  get?(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
};

/** Random, unguessable, extension-fixed key: file names from the client are never used. */
export function newMediaKey(folder: 'products' | 'banners' | 'site' = 'products'): string {
  return `${folder}/${randomBytes(16).toString('hex')}.webp`;
}

/** Keys the public /media route is allowed to serve (anything else is a 404, never a bucket listing). */
export const SERVABLE_MEDIA_KEY = /^(products|banners|site)\/[0-9a-f]{32}\.webp$/;

/** Keys we created (as opposed to seeded site paths such as /assets/x.png or full URLs). */
export function isManagedMediaKey(key: string): boolean {
  return /^products\/[0-9a-f]{32}\.webp$/.test(key);
}

/** S3-compatible storage from the S3_* environment variables. Creates the bucket on first use if missing. */
export function s3StorageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const endpoint = env.S3_ENDPOINT;
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY;
  const secretAccessKey = env.S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new AppError('VALIDATION_FAILED', 'Object storage is not configured (S3_* variables).');
  }
  type Sdk = typeof import('@aws-sdk/client-s3');
  let loaded: Promise<{ sdk: Sdk; client: InstanceType<Sdk['S3Client']> }> | undefined;
  // The AWS SDK is large: load it only when an upload or delete actually happens.
  const getClient = () =>
    (loaded ??= import('@aws-sdk/client-s3').then((sdk) => ({
      sdk,
      client: new sdk.S3Client({
        endpoint,
        region: env.S3_REGION ?? 'us-east-1',
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      }),
    })));
  let bucketReady: Promise<void> | undefined;
  const ensureBucket = () =>
    (bucketReady ??= (async () => {
      const { sdk, client } = await getClient();
      try {
        await client.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
      }
    })().catch((err) => {
      bucketReady = undefined;
      throw err;
    }));
  return {
    async put(key, body, contentType) {
      await ensureBucket();
      const { sdk, client } = await getClient();
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
    async remove(key) {
      const { sdk, client } = await getClient();
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async get(key) {
      const { sdk, client } = await getClient();
      try {
        const out = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!out.Body) return null;
        return {
          body: await out.Body.transformToByteArray(),
          contentType: out.ContentType ?? 'application/octet-stream',
        };
      } catch (err) {
        const name = (err as { name?: string }).name;
        // Nothing was ever uploaded (no key, or the bucket does not exist yet): a plain "not found".
        if (name === 'NoSuchKey' || name === 'NoSuchBucket') return null;
        throw err;
      }
    },
  };
}

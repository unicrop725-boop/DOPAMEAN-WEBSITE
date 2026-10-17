/**
 * Upload validation that needs no image library (brief section 9). Pure: bytes in, verdict out.
 * We never trust the client MIME type or file name: the type comes from the file's own magic bytes,
 * and SVG (which can carry script) is not accepted at all.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_EDGE_PX = 2400;

export type ImageKind = 'jpeg' | 'png' | 'webp';

export type UploadVerdict =
  | { ok: true; kind: ImageKind }
  | {
      ok: false;
      reason: 'EMPTY' | 'TOO_LARGE' | 'SVG' | 'UNSUPPORTED_TYPE' | 'EMBEDDED_MARKUP';
      message: string;
    };

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/** The image type implied by the first bytes, or null. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  // "RIFF" + 4 size bytes + "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'webp';
  return null;
}

const MARKUP_SIGNATURES = ['<svg', '<script', '<html', '<iframe', '<?php', '<!doctype html'];

function latin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** A real photo never contains these; a polyglot (valid image header, script or SVG payload) does. */
export function findEmbeddedMarkup(bytes: Uint8Array): string | null {
  const text = latin1(bytes).toLowerCase();
  return MARKUP_SIGNATURES.find((sig) => text.includes(sig)) ?? null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = latin1(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/** Decide whether these bytes may even be handed to the image decoder. */
export function validateUpload(bytes: Uint8Array, maxBytes = MAX_UPLOAD_BYTES): UploadVerdict {
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY', message: 'The file is empty.' };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      message: `The image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    };
  }
  const kind = sniffImage(bytes);
  if (!kind) {
    if (looksLikeSvg(bytes)) {
      return {
        ok: false,
        reason: 'SVG',
        message: 'SVG images are not allowed. Use JPEG, PNG or WebP.',
      };
    }
    return {
      ok: false,
      reason: 'UNSUPPORTED_TYPE',
      message: 'Only JPEG, PNG and WebP images are accepted.',
    };
  }
  const markup = findEmbeddedMarkup(bytes);
  if (markup) {
    return {
      ok: false,
      reason: 'EMBEDDED_MARKUP',
      message: 'The file contains embedded markup and was refused.',
    };
  }
  return { ok: true, kind };
}

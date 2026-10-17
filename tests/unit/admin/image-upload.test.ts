import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  findEmbeddedMarkup,
  isManagedMediaKey,
  newMediaKey,
  processImageUpload,
  sniffImage,
  validateUpload,
} from '@/modules/catalog';

const png = (w = 40, h = 30) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#cc2222' } })
    .png()
    .toBuffer();
const jpeg = (w = 40, h = 30) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#22cc22' } })
    .jpeg()
    .toBuffer();
const webp = (w = 40, h = 30) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#2222cc' } })
    .webp()
    .toBuffer();
const text = (s: string) => new Uint8Array(Buffer.from(s));

describe('sniffImage: the type comes from magic bytes only', () => {
  it('recognises JPEG, PNG and WebP', async () => {
    expect(sniffImage(await jpeg())).toBe('jpeg');
    expect(sniffImage(await png())).toBe('png');
    expect(sniffImage(await webp())).toBe('webp');
  });

  it.each([
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['html', '<!doctype html><html></html>'],
    ['plain text named .jpg', 'not an image'],
    ['gif', 'GIF89a\u0001\u0000'],
    ['riff but not webp (wav)', 'RIFF\u0000\u0000\u0000\u0000WAVEfmt '],
    ['php', '<?php echo 1; ?>'],
  ])('refuses %s', (_n, body) => {
    expect(sniffImage(text(body))).toBeNull();
  });

  it('refuses truncated headers and empty input', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe('validateUpload', () => {
  it('accepts a real image', async () => {
    expect(validateUpload(await png())).toEqual({ ok: true, kind: 'png' });
  });

  it('rejects empty files', () => {
    expect(validateUpload(new Uint8Array())).toMatchObject({ ok: false, reason: 'EMPTY' });
  });

  it('rejects files over the 5 MB limit even when the header is valid', async () => {
    const big = Buffer.concat([await png(), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(validateUpload(big)).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
    // exactly at the limit is fine
    const exact = Buffer.concat([await png(), Buffer.alloc(MAX_UPLOAD_BYTES)]).subarray(
      0,
      MAX_UPLOAD_BYTES,
    );
    expect(validateUpload(exact).ok).toBe(true);
  });

  it('rejects SVG explicitly (script can hide in it)', () => {
    expect(
      validateUpload(
        text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ),
    ).toMatchObject({ ok: false, reason: 'SVG' });
    expect(
      validateUpload(text('<?xml version="1.0"?>\n<svg width="1" height="1"></svg>')),
    ).toMatchObject({ ok: false, reason: 'SVG' });
    expect(validateUpload(text('   \n<SVG></SVG>'))).toMatchObject({ ok: false, reason: 'SVG' });
  });

  it('rejects other types: wrong magic bytes, executables, text', () => {
    expect(validateUpload(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toMatchObject({
      ok: false,
      reason: 'UNSUPPORTED_TYPE',
    });
    expect(validateUpload(text('hello'))).toMatchObject({ ok: false, reason: 'UNSUPPORTED_TYPE' });
  });

  it('rejects polyglots: a valid image header with markup or script appended or embedded', async () => {
    const base = await jpeg();
    for (const payload of [
      '<script>alert(1)</script>',
      '<SCRIPT SRC=//evil></SCRIPT>',
      '<svg onload=alert(1)>',
      '<html><body>x</body></html>',
      '<iframe src=javascript:alert(1)>',
      '<?php system($_GET[0]); ?>',
    ]) {
      const polyglot = Buffer.concat([base, Buffer.from(payload)]);
      expect(validateUpload(polyglot), payload).toMatchObject({
        ok: false,
        reason: 'EMBEDDED_MARKUP',
      });
    }
    expect(findEmbeddedMarkup(base)).toBeNull();
  });
});

describe('processImageUpload: decode and re-encode', () => {
  it('turns PNG, JPEG and WebP into WebP', async () => {
    for (const make of [png, jpeg, webp]) {
      const out = await processImageUpload(await make(50, 20));
      expect(out.contentType).toBe('image/webp');
      expect(out.width).toBe(50);
      expect(out.height).toBe(20);
      expect(out.data.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect((await sharp(out.data).metadata()).format).toBe('webp');
    }
  });

  it('scales down to at most 2400 px on the long edge keeping the aspect ratio, never up', async () => {
    const wide = await processImageUpload(await png(4800, 1200));
    expect([wide.width, wide.height]).toEqual([2400, 600]);
    const tall = await processImageUpload(await png(1000, 3000));
    expect([tall.width, tall.height]).toEqual([800, 2400]);
    const small = await processImageUpload(await png(100, 100));
    expect([small.width, small.height]).toEqual([100, 100]);
  });

  it('strips metadata (EXIF, GPS) from the output', async () => {
    const withExif = await sharp({
      create: { width: 30, height: 30, channels: 3, background: '#888888' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner', Artist: 'Someone' } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await processImageUpload(withExif);
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.data.toString('latin1')).not.toContain('secret-owner');
  });

  it('applies EXIF orientation before stripping it', async () => {
    const rotated = await sharp({
      create: { width: 60, height: 20, channels: 3, background: '#aa0000' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await processImageUpload(rotated);
    expect([out.width, out.height]).toEqual([20, 60]);
  });

  it('refuses corrupt images that merely start with valid magic bytes', async () => {
    const real = await png();
    const truncated = real.subarray(0, 40);
    await expect(processImageUpload(truncated)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    await expect(processImageUpload(garbage)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a file whose extension-style claim and bytes disagree (SVG, text) and polyglots, with a clear message', async () => {
    await expect(processImageUpload(text('<svg/>'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('SVG'),
    });
    await expect(
      processImageUpload(Buffer.concat([await png(), Buffer.from('<script>x</script>')])),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('markup'),
    });
    await expect(processImageUpload(new Uint8Array())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses oversize input before decoding, honouring a custom limit', async () => {
    const real = await png(200, 200);
    await expect(processImageUpload(real, 100)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('larger'),
    });
  });

  it('refuses a decompression bomb (huge pixel count in a tiny file)', async () => {
    const bomb = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: '#000000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(MAX_UPLOAD_BYTES);
    await expect(processImageUpload(bomb)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('object keys', () => {
  it('are random, fixed-extension, and recognised as managed', () => {
    const a = newMediaKey();
    const b = newMediaKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^products\/[0-9a-f]{32}\.webp$/);
    expect(isManagedMediaKey(a)).toBe(true);
  });

  it('never treats site paths, URLs or traversal as managed keys', () => {
    for (const k of [
      '/assets/a.png',
      'https://cdn.example/x.webp',
      'products/../secret.webp',
      'products/abc.webp',
      'products/' + 'g'.repeat(32) + '.webp',
      'products/' + 'a'.repeat(32) + '.svg',
    ]) {
      expect(isManagedMediaKey(k), k).toBe(false);
    }
  });
});

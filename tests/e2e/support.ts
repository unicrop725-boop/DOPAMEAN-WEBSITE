import { createHmac } from 'node:crypto';
import { MAILPIT_URL } from './env';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`bad base32 char ${ch}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), the Better Auth default. */
export function totp(secretBase32: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

export function secretFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('no secret in otpauth uri');
  return secret;
}

type MailpitMessage = { ID: string; To: { Address: string }[]; Subject: string };

/**
 * Poll Mailpit until a message to `to` arrives (optionally with a subject matching `subject`);
 * returns its plain-text body. Messages are searched newest first.
 */
export async function waitForEmail(
  to: string,
  opts: { subject?: RegExp; timeoutMs?: number } = {},
): Promise<{ subject: string; text: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const body = (await res.json()) as { messages?: MailpitMessage[] };
    for (const msg of body.messages ?? []) {
      if (opts.subject && !opts.subject.test(msg.Subject)) continue;
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`)).json()) as {
        Text: string;
        Subject: string;
      };
      return { subject: full.Subject, text: full.Text };
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no matching email to ${to} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function firstUrl(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  if (!m) throw new Error('no url in email');
  return m[0];
}

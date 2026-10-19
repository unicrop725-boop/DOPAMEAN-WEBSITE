import { describe, expect, it } from 'vitest';
import { resetPasswordMessage, verifyEmailMessage } from '@/modules/notifications';

describe('email templates', () => {
  it('escape user-controlled names in HTML but keep plain text readable', () => {
    const m = verifyEmailMessage(
      'x@y.test',
      '<script>alert(1)</script>',
      'https://shop.test/v?t=1&u=2',
    );
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('t=1&amp;u=2');
    expect(m.text).toContain('https://shop.test/v?t=1&u=2');
  });

  it('includes the link and brand in reset emails', () => {
    const m = resetPasswordMessage('x@y.test', 'Asha', 'https://shop.test/reset?token=abc');
    expect(m.subject).toMatch(/DOPAMEAN/);
    expect(m.text).toContain('https://shop.test/reset?token=abc');
  });
});
